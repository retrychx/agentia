#!/usr/bin/env python3
"""把 Terminal-Bench 任务目录转成 Harbor 任务目录。

为什么需要它：Terminal-Bench 的任务格式和 Harbor 的不一样，而 Harbor 目前
**不认** TB 格式（`harbor run -p <TB任务目录>` 会报
`Either datasets or tasks must be provided`）。两者差异：

| | Terminal-Bench | Harbor |
|---|---|---|
| 任务描述 | `task.yaml` 的 `instruction:` | `instruction.md`（独立文件） |
| 元数据 | `task.yaml` | `task.toml`（`[task]` / `[metadata]` / … 分节） |
| 环境 | `Dockerfile`（根目录） | `environment/Dockerfile` |
| 测试 | `tests/` + `run-tests.sh` | `tests/test.sh`（**必须自己写 reward 文件**） |
| 参考解 | `solution.sh` | `solution/solve.sh` |

⚠️ 最大的语义差异是**奖励怎么产生**：TB 用 `run-tests.sh` 跑 pytest，Harbor 的 verifier
只认 `/logs/verifier/reward.txt`。少写这一步，Harbor 会报 `RewardFileNotFoundError`，
而 agent 其实早就做完事了 —— 看着像 agent 失败，其实是验证脚本没接上。

用法：
    python3 scripts/tb_task_to_harbor.py <tb_task_dir> <out_dir>
    # 批量
    python3 scripts/tb_task_to_harbor.py --all <tb_tasks_root> <out_root>

依赖：只有标准库（不引 pyyaml —— 本仓对示例依赖也克制，TB 的 task.yaml 是简单
`key: value` + 块标量，够用）。
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

# pytest 装进**任务镜像**（不是 verifier 里现装）。理由：Terminal-Bench 的基础镜像
# 不带 pytest（python-* 镜像也不带 uv），而 verifier 里现装每轮都要多一次出网 ——
# 慢，且会撞 verifier 超时，最糟的是失败时长成「agent 做错了」。
# 官方 TB 靠 run-tests.sh 现场 `curl astral.sh/uv | sh` 再建 venv（要出网 + curl）；
# 这里改在**构建期**一次性装好，运行时零出网。
# 分层兜底覆盖两类基础镜像（都实测过）：
#   python-3-13 → 自带 pip3（pip 24.3.1），走 pip 装 TB 同款 pytest==8.4.1；
#   ubuntu-24-04 → 有 python3 但**没有 pip、也没有 curl**，走 apt 装 python3-pytest。
# 版本差异（8.4.1 vs 发行版自带）对断言无影响，但口径要写出来，别假装等价。
PYTEST_INSTALL_LINE = """RUN set -e \\
 && if python3 -m pip --version >/dev/null 2>&1; then \\
      python3 -m pip install --no-cache-dir pytest==8.4.1; \\
    elif command -v apt-get >/dev/null 2>&1; then \\
      apt-get update -qq && apt-get install -y -qq --no-install-recommends python3-pytest; \\
    else \\
      echo "tb_task_to_harbor: 这个镜像既没有 pip 也没有 apt-get，装不上 pytest" >&2; exit 1; \\
    fi
"""

# 测试脚本模板。⚠️ 别用 uv：Terminal-Bench 的 python-3-13 基础镜像里**没有 uv**，
# 照着 TB 的 run-uv-pytest.sh 抄会得到 `uv: command not found` ⇒ reward 恒 0。
TEST_SH = """#!/bin/bash
# 由 tb_task_to_harbor.py 生成：Harbor 的 verifier 只认 reward 文件，不认 pytest 退出码。
# pytest 由任务镜像提供（转换时已写进 Dockerfile）—— 这里不现装。
#
# ⚠️ 故意**不 cd**：TB 的 run-tests.sh 也不 cd，测试里的相对路径（例如
# `./process_data.sh`）依赖容器的 WORKDIR。基础镜像都设了 WORKDIR=/app，
# 让 Harbor 的 exec 跟着容器 WORKDIR 走 = 与 TB 同口径。
echo "verifier cwd = $PWD"
if ! python3 -m pytest --version >/dev/null 2>&1; then
  # ⚠️ 故意**不写** reward：缺 pytest 是环境问题，不是任务失败。
  # 写了 reward=0 会被当成「agent 没做对」，与真失败无从区分；不写则 Harbor 报
  # RewardFileNotFoundError —— 一眼看出是基础设施，而不是分数。
  echo "FATAL: 镜像里没有 pytest（转换时应写进 Dockerfile）" >&2
  exit 1
fi
python3 -m pytest /tests/test_outputs.py -rA
rc=$?
if [ "$rc" -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
"""

TASK_TOML = """schema_version = "1.4"
artifacts = []

[task]
name = "{name}"
version = "1.0.0"
description = "{description}"
authors = []
keywords = []

[metadata]
author_name = "{author}"
author_email = "unknown"
difficulty = "{difficulty}"
category = "software_engineering"
tags = []
expert_time_estimate_min = 1.0
junior_time_estimate_min = 1.0

[verifier]
timeout_sec = {verifier_timeout}
collect = []

[verifier.env]

[agent]
timeout_sec = {agent_timeout}

[environment]
network_mode = "public"
build_timeout_sec = 600.0
os = "linux"
mcp_servers = []

[environment.env]

[solution.env]
"""


def parse_task_yaml(text: str) -> dict[str, str]:
    """极简 task.yaml 解析：只认顶层标量 + 块标量（`|-` / `|` / `>`）。

    不引 pyyaml 的理由：这是示例，不是通用 YAML 实现；TB 的 task.yaml 结构固定，
    真需要复杂 YAML 的人应该直接用 harbor 自己的 schema。
    """
    out: dict[str, str] = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if not m:
            i += 1
            continue
        key, rest = m.group(1), m.group(2)
        rest = rest.rstrip()
        if rest in ("|", "|-", "|+", ">", ">-"):
            # 块标量：收集后续缩进更深的行
            block: list[str] = []
            i += 1
            while i < len(lines):
                nxt = lines[i]
                if nxt.strip() == "":
                    block.append("")
                    i += 1
                    continue
                if re.match(r"^\s", nxt):
                    block.append(re.sub(r"^\s{2}", "", nxt, count=1))
                    i += 1
                    continue
                break
            # `|-` 去掉尾随空行
            while block and block[-1] == "":
                block.pop()
            out[key] = "\n".join(block)
            continue
        out[key] = rest.strip().strip('"').strip("'")
        i += 1
    return out


def convert_one(src: Path, dst: Path, org: str = "terminal-bench") -> str:
    """转换单个任务，返回任务名。"""
    task_yaml_path = src / "task.yaml"
    if not task_yaml_path.exists():
        raise FileNotFoundError(f"{src} 下没有 task.yaml（不是 Terminal-Bench 任务？）")
    meta = parse_task_yaml(task_yaml_path.read_text(encoding="utf-8"))

    instruction = meta.get("instruction", "").strip()
    if not instruction:
        raise ValueError(f"{src} 的 task.yaml 里没有 instruction")

    # 从 instruction 首句派生一句 description（harbor 的 task.toml 要它）
    first_line = instruction.splitlines()[0].strip()
    description = (first_line[:110] + "…") if len(first_line) > 110 else first_line
    description = description.replace('"', "'")

    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)

    (dst / "instruction.md").write_text(f"{instruction}\n", encoding="utf-8")

    # ⚠️ 构建上下文 = **TB 任务根整份**，不是只有 Dockerfile。
    # 实证（扫了 236 个 Dockerfile）：32 个 `COPY task-deps/`、18 个 `COPY tests/`、
    # 还有 `etc/ src/ resources/ data/ protected/ setup.sh …`。TB 的 docker-compose
    # 没写 `context:` ⇒ 默认就是 compose 文件所在目录 = 任务根。
    # 只搬 Dockerfile 的话，`COPY process_data.sh .` 这类会直接 build 失败。
    # 排除的只是「转换产物」与 TB 自己的编排文件 —— 它们在 TB 的上下文里没人引用。
    excluded = {
        "task.toml", "instruction.md", "environment", "solution",
        "docker-compose.yaml", "compose.yaml", ".git",
    }
    (dst / "environment").mkdir()

    def _ignore(_dir: str, names: list[str]) -> list[str]:
        return [n for n in names if n in excluded]

    for entry in src.iterdir():
        if entry.name in excluded:
            continue
        target = dst / "environment" / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target, ignore=_ignore, symlinks=True)
        else:
            shutil.copy2(entry, target)

    dockerfile = dst / "environment" / "Dockerfile"
    if not dockerfile.exists():
        raise FileNotFoundError(f"{src} 下没有 Dockerfile（用预构建镜像的任务本例不支持）")

    docker_src = dockerfile.read_text(encoding="utf-8")
    # 补 WORKDIR：TB 的基础镜像**自带 WORKDIR=/app**（实测 python-3-13 与 ubuntu-24-04
    # 都是），所以多数任务不用补。实测：152/236 自带 WORKDIR（其中 142 个就是 /app），
    # 84 个没写、靠镜像默认。⇒ 只在**完全没有** WORKDIR 时才补 /app：
    # 无条件追加会把任务自己设的（实测有 /workspace、/home/alice…）顶掉。
    if not re.search(r"^\s*WORKDIR\s", docker_src, re.MULTILINE | re.IGNORECASE):
        docker_src = f"{docker_src.rstrip()}\nWORKDIR /app\n"
    # 补 pytest：verifier 要跑 test_outputs.py，但基础镜像不带 pytest（见 PYTEST_INSTALL_LINE）
    if "pytest" not in docker_src:
        docker_src = f"{docker_src.rstrip()}\n{PYTEST_INSTALL_LINE}"
    dockerfile.write_text(docker_src, encoding="utf-8")

    # 测试：抄 TB 的 test_outputs.py（断言本体），但 test.sh 用我们的模板
    (dst / "tests").mkdir()
    tests_src = src / "tests"
    if tests_src.is_dir():
        for f in tests_src.iterdir():
            if f.name in ("run-uv-pytest.sh", "setup-uv-pytest.sh", "run-tests.sh"):
                continue  # TB 的 runner 脚本不用：harbor 走自己的 test.sh
            if f.is_file():
                shutil.copy2(f, dst / "tests" / f.name)
            elif f.is_dir():
                shutil.copytree(f, dst / "tests" / f.name, symlinks=True)
    test_py = dst / "tests" / "test_outputs.py"
    if not test_py.exists():
        raise FileNotFoundError(f"{src} 的 tests/ 下没有 test_outputs.py（本例只支持 pytest 类任务）")
    (dst / "tests" / "test.sh").write_text(TEST_SH, encoding="utf-8")
    (dst / "tests" / "test.sh").chmod(0o755)

    solve = src / "solution.sh"
    if solve.exists():
        (dst / "solution").mkdir()
        solve_dst = dst / "solution" / "solve.sh"
        shutil.copy2(solve, solve_dst)
        solve_dst.chmod(0o755)

    # 超时：TB 用 max_agent_timeout_sec / max_test_timeout_sec（秒），
    # harbor 的 [agent].timeout_sec / [verifier].timeout_sec 同单位。
    def _secs(key: str, default: float) -> float:
        try:
            return float(meta.get(key, "") or default)
        except ValueError:
            return default

    agent_timeout = _secs("max_agent_timeout_sec", 600.0)
    verifier_timeout = _secs("max_test_timeout_sec", 600.0)

    name = f"{org}/{src.name}"
    (dst / "task.toml").write_text(
        TASK_TOML.format(
            name=name,
            description=description,
            author=meta.get("author_email", "unknown"),
            difficulty=meta.get("difficulty", "unknown"),
            agent_timeout=agent_timeout,
            verifier_timeout=verifier_timeout,
        ),
        encoding="utf-8",
    )
    return name


def main() -> int:
    ap = argparse.ArgumentParser(description="Terminal-Bench 任务 → Harbor 任务")
    ap.add_argument("src", type=Path, help="TB 任务目录，或 --all 时的任务集根目录")
    ap.add_argument("dst", type=Path, help="输出目录")
    ap.add_argument("--all", action="store_true", help="把 src 下所有任务都转")
    ap.add_argument("--org", default="terminal-bench", help="Harbor 任务名的组织前缀")
    args = ap.parse_args()

    if not args.all:
        name = convert_one(args.src, args.dst / args.src.name, args.org)
        print(f"转换完成：{name} -> {args.dst / args.src.name}")
        return 0

    ok, skipped = 0, []
    for d in sorted(p for p in args.src.iterdir() if p.is_dir()):
        try:
            convert_one(d, args.dst / d.name, args.org)
            ok += 1
        except Exception as exc:  # noqa: BLE001 —— 批量转换要跳过不支持的任务，不是崩掉
            skipped.append(f"{d.name}: {exc}")
    print(f"转换完成 {ok} 个任务 -> {args.dst}")
    if skipped:
        print(f"跳过 {len(skipped)} 个（多为非 pytest 类任务）：")
        for s in skipped[:10]:
            print(f"  - {s}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
