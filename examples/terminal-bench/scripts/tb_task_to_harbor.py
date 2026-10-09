#!/usr/bin/env python3
"""把 Terminal-Bench 任务目录转成 Harbor 任务目录。

为什么需要它：Terminal-Bench 的任务格式和 Harbor 的不一样，而 Harbor 目前
**不认** TB 格式（`harbor run -p <TB任务目录>` 会报
`Either datasets or tasks must be provided`）。两者差异：

| | Terminal-Bench | Harbor |
|---|---|---|
| 任务描述 | `task.yaml` 的 `instruction:` | `instruction.md`（独立文件） |
| 元数据 | `task.yaml` | `task.toml`（`[task]` / `[metadata]` / … 分节） |
| 环境 | `Dockerfile`（根目录）+ `docker-compose.yaml` | `environment/Dockerfile` |
| 测试 | `tests/` + `run-tests.sh` | `tests/test.sh`（**必须自己写 reward 文件**） |
| 参考解 | `solution.sh` | `solution/solve.sh` |

⚠️ 最大的语义差异是**奖励怎么产生**：TB 用 `run-tests.sh` 跑 pytest，Harbor 的 verifier
只认 `/logs/verifier/reward.txt`。少写这一步，Harbor 会报 `RewardFileNotFoundError`，
而 agent 其实早就做完事了 —— 看着像 agent 失败，其实是验证脚本没接上。

⚠️ 第二大的语义差异是 **compose 里藏的环境语义**：任务的 `docker-compose.yaml` 可能
注入 `environment` / `working_dir` / `entrypoint`，整个丢掉 = 环境错位 ⇒ 假红且日志里
**没有任何提示**。本脚本对照 harbor 官方 mapper（`harbor/mappers/terminal_bench.py`
的 `DockerComposeProcessor`）做单服务提取（→ Dockerfile），做不到的**响亮告警**。

用法：
    python3 scripts/tb_task_to_harbor.py <tb_task_dir> <out_dir>
    # 批量
    python3 scripts/tb_task_to_harbor.py --all <tb_tasks_root> <out_root>

依赖：只有标准库（不引 pyyaml —— 本仓对示例依赖也克制，TB 的 task.yaml / compose
都是简单结构，够用；解不出来的形态一律走告警，不静默猜）。
"""

from __future__ import annotations

import argparse
import json
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
# ⚠️ 这只补 **pytest 本体**；测试自己的依赖（requests / numpy …）由保留下来的
# 原版 run-tests.sh 负责（见 build_test_sh），别指望这一行装全。
PYTEST_INSTALL_LINE = """RUN set -e \\
 && if python3 -m pip --version >/dev/null 2>&1; then \\
      python3 -m pip install --no-cache-dir pytest==8.4.1; \\
    elif command -v apt-get >/dev/null 2>&1; then \\
      apt-get update -qq && apt-get install -y -qq --no-install-recommends python3-pytest; \\
    else \\
      echo "tb_task_to_harbor: 这个镜像既没有 pip 也没有 apt-get，装不上 pytest" >&2; exit 1; \\
    fi
"""

TEST_SH_HEADER = """#!/bin/bash
# 由 tb_task_to_harbor.py 生成：Harbor 的 verifier 只认 reward 文件，不认 pytest 退出码。
#
# ⚠️ 故意**不 cd**：TB 跑 run-tests.sh 时也不 cd，测试里的相对路径（例如
# `./process_data.sh`）依赖容器的 WORKDIR。基础镜像都设了 WORKDIR=/app，
# 让 Harbor 的 exec 跟着容器 WORKDIR 走 = 与 TB 同口径。
# （原版脚本若自己 cd，被包在下面的子 shell 里，不会漏出来污染后续步骤。）
echo "verifier cwd = $PWD"
# TB 的 harness 跑 run-tests.sh 时会注入 TEST_DIR；Harbor 不会 ⇒ 这里补同一个缺省。
# 任务 compose 里显式给了 TEST_DIR 的（转换时已写成 Dockerfile 的 ENV）优先。
: "${TEST_DIR:=/tests}"
export TEST_DIR
"""

# 原版脚本跑完后按退出码落 reward。⚠️ 之所以把原版包在**子 shell** 里再追加这段，
# 而不是直接 append 在原版后面：原版若带 `set -e`，pytest 失败会先杀掉脚本本体，
# reward 永远写不上 ⇒ 真答错被记成 RewardFileNotFoundError（基础设施桶），方向反了。
# 子 shell 里 `set -e` 中止的只是子 shell，退出码原样传出来。
REWARD_SUFFIX = """
_EXIT_CODE=$?
if [ "$_EXIT_CODE" -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
exit $_EXIT_CODE
"""

# 任务里**没有** run-tests.sh 时的兜底：裸跑 pytest（历史行为，见文件头表格）。
# ⚠️ 别用 uv：Terminal-Bench 的 python-3-13 基础镜像里**没有 uv**，
# 照着 TB 的 run-uv-pytest.sh 抄会得到 `uv: command not found` ⇒ reward 恒 0。
TEST_SH_FALLBACK = (
    TEST_SH_HEADER
    + """if ! python3 -m pytest --version >/dev/null 2>&1; then
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
)

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

# ---------------------------------------------------------------- compose 提取
# TB 编排自己注入的环境变量（不是任务语义）：TB harness 跑测试时 TEST_DIR=/tests，
# 换成等价的 Dockerfile ENV（harbor 官方 mapper 同款，见 extract_dockerfile_additions）。
TB_COMPOSE_DEFAULT_ENV = {"TEST_DIR": "/tests"}

# compose 主服务里**不携带环境语义**的字段：镜像名 / 容器名 / 保活命令 / 重启策略等
# （Harbor 用自己的 compose 包一层，容器生命周期归它管），跳过、不告警。
COMPOSE_IGNORED_FIELDS = {
    "build",
    "image",
    "container_name",
    "command",
    "restart",
    "tty",
    "stdin_open",
    "init",
    "labels",
    "hostname",
}

# 能翻成 Dockerfile 的字段（environment / working_dir / entrypoint / expose）
COMPOSE_HANDLED_FIELDS = {"environment", "working_dir", "entrypoint", "expose"}

# 保活型 entrypoint：TB 的 compose 靠它吊住容器（sleep infinity / tail -f /dev/null）。
# Harbor 自己保活 ⇒ 翻进 Dockerfile 反而改任务语义，跳过（不告警：TB 的 compose 全是它）。
KEEPALIVE_RE = re.compile(r"sleep\s+(infinity|inf\b|\d{4,})|tail\s+-f\s+/dev/null")


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


def _yaml_scalar(text: str) -> str:
    """compose 里的标量：去首尾空白、行尾注释与成对引号。"""
    s = text.strip()
    if " #" in s:
        s = s.split(" #", 1)[0].rstrip()
    return s.strip('"').strip("'")


def _parse_inline_value(rest: str) -> object:
    """行内值：flow 列表 `[a, b]` 解成 list（entrypoint 常用），其余按标量。"""
    if rest.startswith("[") and rest.endswith("]"):
        inner = rest[1:-1].strip()
        if not inner:
            return []
        return [_yaml_scalar(x) for x in inner.split(",")]
    return _yaml_scalar(rest)


def parse_compose_services(text: str) -> dict[str, dict[str, object]]:
    """极简 compose 提取（与 parse_task_yaml 同一原则：不引 pyyaml，够用就好）。

    只解 `services:` 下的两级缩进；服务字段只解三种形态：
    标量 `key: value`、块列表 `key:` + `- item`、块映射 `key:` + `sub: val`。
    解不出来的形态原样留给调用方 ⇒ 走「未转换」告警，不静默猜。
    """
    services: dict[str, dict[str, object]] = {}
    in_services = False
    services_indent = 0
    cur: str | None = None
    cur_field: str | None = None
    field_indent = 0
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if indent == 0:
            in_services = stripped.split(":", 1)[0].strip() == "services"
            cur = None
            cur_field = None
            continue
        if not in_services:
            continue
        if cur is None or indent <= services_indent:
            # 服务名行：`  client:`（第一个服务确立 services 块的缩进档）
            m = re.match(r"^([^:\s][^:]*):\s*(.*)$", stripped)
            if not m:
                continue
            cur = _yaml_scalar(m.group(1))
            services_indent = indent
            services[cur] = {}
            cur_field = None
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", stripped)
        if m and not stripped.startswith("- "):
            key, rest = m.group(1), m.group(2).strip()
            cur_field = key
            field_indent = indent
            services[cur][key] = _parse_inline_value(rest) if rest else {}
            if rest:
                cur_field = None
            continue
        # 字段的块内容（缩进比字段行更深）
        if cur_field is not None and indent > field_indent:
            val: object = services[cur].get(cur_field)
            if stripped.startswith("- "):
                if not isinstance(val, list):
                    val = []
                val.append(_yaml_scalar(stripped[2:]))
            else:
                km = re.match(r"^([^:]+):\s*(.*)$", stripped)
                if km:
                    if not isinstance(val, dict):
                        val = {}
                    val[_yaml_scalar(km.group(1))] = _yaml_scalar(km.group(2))
            services[cur][cur_field] = val
    return services


def extract_compose_additions(compose_text: str) -> tuple[list[str], list[str]]:
    """从 compose 提取能翻成 Dockerfile 的环境语义。

    返回 (Dockerfile 追加行, 告警列表)。做不到的（多服务 / 卷 / 端口 / 插值 …）
    全进告警列表 —— **响亮**是重点：环境错位 ⇒ 假红，静默丢 = 排查无门。
    """
    services = parse_compose_services(compose_text)
    additions: list[str] = []
    warnings: list[str] = []
    if not services:
        return additions, warnings

    names = list(services)
    main = "client" if "client" in services else names[0]
    if len(names) > 1:
        warnings.append(
            f"docker-compose.yaml 有 {len(names)} 个服务（{', '.join(names)}）："
            f"只提取了主服务 `{main}` 的环境语义，**其余服务未转换** —— "
            "该任务若依赖 sidecar 容器，转出来的环境与原任务**不等价**"
        )
    svc = services[main]

    for key in sorted(set(svc) - COMPOSE_HANDLED_FIELDS - COMPOSE_IGNORED_FIELDS - {"volumes"}):
        warnings.append(f"compose 主服务的 `{key}` 未转换（Harbor 任务只认 Dockerfile）")

    volumes = svc.get("volumes")
    if volumes:
        items = volumes if isinstance(volumes, list) else [volumes]
        non_tb = [str(v) for v in items if "${T_BENCH_" not in str(v)]
        if non_tb:
            warnings.append(f"compose 的 volumes 含非 TB 日志挂载 {non_tb}，未转换")

    env = svc.get("environment")
    env_items: dict[str, str] = {}
    if isinstance(env, dict):
        env_items = {str(k): str(v) for k, v in env.items()}
    elif isinstance(env, list):
        for item in env:
            if "=" in item:
                k, v = item.split("=", 1)
                env_items[k] = v
            else:
                env_items[item] = ""
    elif env is not None:
        warnings.append(f"compose 的 environment 形态没解出来（{env!r}），未转换")
    for k, v in env_items.items():
        if k in TB_COMPOSE_DEFAULT_ENV:
            additions.append(f"ENV {k}={TB_COMPOSE_DEFAULT_ENV[k]}")
        elif "${" in v:
            warnings.append(f"compose 的 environment `{k}={v}` 含变量插值，未转换")
        else:
            additions.append(f"ENV {k}={v}")

    wd = svc.get("working_dir")
    if isinstance(wd, str) and wd:
        if "${" in wd:
            warnings.append(f"compose 的 working_dir `{wd}` 含变量插值，未转换")
        else:
            # compose 的 working_dir **覆盖**镜像 WORKDIR ⇒ 追加在后（后出现者生效），
            # 且要抢在下面「完全没有 WORKDIR 才补 /app」的兜底之前落定。
            additions.append(f"WORKDIR {wd}")

    ep = svc.get("entrypoint")
    if ep:
        parts = [str(p) for p in ep] if isinstance(ep, list) else [str(ep)]
        if not KEEPALIVE_RE.search(" ".join(parts)):
            additions.append(f"ENTRYPOINT {json.dumps(parts)}")

    expose = svc.get("expose")
    if expose:
        ports = expose if isinstance(expose, list) else [expose]
        additions.extend(f"EXPOSE {p}" for p in ports)

    return additions, warnings


def build_test_sh(src: Path, tests_src: Path) -> str:
    """生成 tests/test.sh：**保留原版 run-tests.sh**，尾部接 reward 落盘。

    为什么不能再整段换成裸 `pytest /tests/test_outputs.py`（本脚本曾经这么干）：
    原版 run-tests.sh 里的 `uv pip install pytest requests numpy …` 装的是
    **测试自己的依赖** —— 丢掉它 ⇒ import 失败 ⇒ reward 0，与「agent 没做对」无从区分
    （条件性假红）。⚠️ 别用 uv 自己重写一遍：python-3-13 基础镜像里没有 uv，
    照抄 run-uv-pytest.sh 会得到 `uv: command not found`（uv 的安装步骤在原版脚本里）。
    """
    # run-tests.sh 的位置两种都见过：tests/ 下（2.0 主流）与任务根（harbor mapper 认根）
    original = next(
        (p for p in (tests_src / "run-tests.sh", src / "run-tests.sh") if p.is_file()),
        None,
    )
    if original is None:
        return TEST_SH_FALLBACK
    body = original.read_text(encoding="utf-8")
    # 剥掉 shebang：脚本要嵌进生成的 test.sh 中间，不是独立入口
    body = re.sub(r"\A#!.*\n", "", body)
    return (
        TEST_SH_HEADER
        + "# ---- 以下为 TB 原版 run-tests.sh（包在子 shell 里：它自己的 set -e / cd\n"
        + "#      不会漏出来挡住 reward 落盘，见 REWARD_SUFFIX 的注释）\n(\n"
        + body.rstrip("\n")
        + "\n)\n"
        + REWARD_SUFFIX
    )


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
    # 排除的只是「转换产物」与 TB 自己的编排文件 —— 编排文件的**语义**不丢：
    # compose 里的 environment / working_dir / entrypoint 在下面翻进 Dockerfile。
    excluded = {
        "task.toml", "instruction.md", "environment", "solution",
        "docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml", ".git",
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

    # compose → Dockerfile：能翻的翻（ENV / WORKDIR / ENTRYPOINT / EXPOSE），
    # 翻不了的**响亮告警**（多服务 / 卷 / 端口 / 变量插值），别静默丢成假红。
    compose_path = next(
        (
            src / name
            for name in ("docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml")
            if (src / name).exists()
        ),
        None,
    )
    if compose_path is not None:
        additions, warnings = extract_compose_additions(
            compose_path.read_text(encoding="utf-8")
        )
        if additions:
            docker_src = (
                f"{docker_src.rstrip()}\n\n# 从 {compose_path.name} 提取（tb_task_to_harbor.py）\n"
                + "\n".join(additions)
                + "\n"
            )
        for w in warnings:
            print(f"[tb_task_to_harbor] ⚠️ {src.name}: {w}")

    # 补 WORKDIR：TB 的基础镜像**自带 WORKDIR=/app**（实测 python-3-13 与 ubuntu-24-04
    # 都是），所以多数任务不用补。实测：152/236 自带 WORKDIR（其中 142 个就是 /app），
    # 84 个没写、靠镜像默认。⇒ 只在**完全没有** WORKDIR 时才补 /app：
    # 无条件追加会把任务自己设的（实测有 /workspace、/home/alice…）顶掉。
    # ⚠️ 这一步排在 compose 提取**之后**：compose 给了 working_dir 的，Dockerfile 里
    # 已经有 WORKDIR（上面追加的），兜底自然不再触发 —— 与 compose 覆盖语义一致。
    if not re.search(r"^\s*WORKDIR\s", docker_src, re.MULTILINE | re.IGNORECASE):
        docker_src = f"{docker_src.rstrip()}\nWORKDIR /app\n"
    # 补 pytest：verifier 要跑 test_outputs.py，但基础镜像不带 pytest（见 PYTEST_INSTALL_LINE）
    if "pytest" not in docker_src:
        docker_src = f"{docker_src.rstrip()}\n{PYTEST_INSTALL_LINE}"
    dockerfile.write_text(docker_src, encoding="utf-8")

    # 测试：抄 TB 的 tests/（断言本体），test.sh 保留原版 run-tests.sh + reward 落盘
    (dst / "tests").mkdir()
    tests_src = src / "tests"
    if tests_src.is_dir():
        for f in tests_src.iterdir():
            # ⚠️ runner 脚本（run-uv-pytest.sh / setup-uv-pytest.sh）**不再丢弃**：
            # 原版 run-tests.sh 可能 source 它们（装 uv / 建 venv），丢了就是假红。
            if f.is_file():
                shutil.copy2(f, dst / "tests" / f.name)
            elif f.is_dir():
                shutil.copytree(f, dst / "tests" / f.name, symlinks=True)
    test_py = dst / "tests" / "test_outputs.py"
    if not test_py.exists():
        raise FileNotFoundError(f"{src} 的 tests/ 下没有 test_outputs.py（本例只支持 pytest 类任务）")
    test_sh_path = dst / "tests" / "test.sh"
    test_sh_path.write_text(build_test_sh(src, tests_src), encoding="utf-8")
    test_sh_path.chmod(0o755)

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
