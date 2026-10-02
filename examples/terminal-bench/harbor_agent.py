"""
Harbor 适配层：把 agentia 装进 Terminal-Bench 的任务容器。

为什么需要这个 Python 文件（明明 agentia 是 TS 框架）：
Harbor 的自定义 agent **必须**是一个 Python 类 —— 但它的职责只是「在任务容器里装好
agent 的 CLI 再跑起来」（`BaseInstalledAgent`，与官方 `eve` 适配器同一套路：
`eve_runner.mjs` 才是真正的 agent）。所以这里没有一行 agent 逻辑，
真正的 agent 是 `dist/run.js`。

用法（Harbor 按 `模块路径:类名` 加载自定义 agent）：

    harbor run -d terminal-bench@2.0 \
      -a agentia_tb.harbor_agent:Agentia \
      -m anthropic/claude-opus-4-1 \
      --ae ANTHROPIC_API_KEY="$ANTHropic_API_KEY"

注意：模块必须能被 Harbor 进程 import ⇒ 跑之前把本目录放进 PYTHONPATH，
或用 `harbor run -a path.to.harbor_agent:Agentia`（见 README）。
"""

from __future__ import annotations

import os
import shlex
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from typing import override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

PROJECT_DIR = Path(__file__).resolve().parent
REMOTE_DIR = PurePosixPath("/installed-agent/agentia-tb")
INSTRUCTION_PATH = PurePosixPath("/installed-agent/instruction.txt")

# 装载脚本在 stdout 上回传 node 绝对路径的那行标记。**交接只有这一处**，
# 改它必须同步 `scripts/container-install-runtime.sh` 文件头的「输出契约」。
#
# 为什么不落 `.node-bin` 文件：**非 root 任务容器里写不进去**。Harbor 的上传走
# `docker compose exec -T -u root … tar -xf`，远端目录整棵是 root 拥有的；
# 实测（`USER nobody`）在 `/installed-agent/agentia-tb` 里 `touch` 是 Permission denied，
# 于是「把解析结果写在远端目录、下一步再读」这条路在非 root 下必挂。
NODE_BIN_MARKER = "AGENTIA_NODE_BIN="

# 框架包的本体在工作区根（本示例是 `file:../..`），容器里没有工作区 ⇒ 得把**构建好的**
# 包整个搬进去。可用 AGENTIA_PKG_ROOT 指向别处（例如解包后的 tarball）。
PKG_ROOT = Path(os.environ.get("AGENTIA_PKG_ROOT", PROJECT_DIR.parent.parent)).resolve()

# 需要透传给容器内 agent 的密钥变量名（只在宿主机设了才传，避免塞一堆空值）
SECRET_ENV_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL")


class Agentia(BaseInstalledAgent):
    """在任务容器里安装并运行 agentia（`@migor/agentia`）的 Harbor 适配器。"""

    # atif=True 告诉 Harbor：这个 agent 产出的轨迹就是 ATIF，不用再从日志反推。
    # 这是本适配器与「跑完拿 stdout 猜步骤」那类适配器的分界线。
    capabilities = AgentCapabilities(atif=True)

    # install 阶段解析出的 node 绝对路径，供 run 阶段用（同一个 trial 里是同一个实例对象，
    # Harbor 在 `Trial._setup_agent` 建实例、`_run_agent_phase` 复用）。
    _node_bin: str | None = None

    @staticmethod
    def name() -> str:
        return "agentia"

    def version(self) -> str | None:
        return os.environ.get("AGENTIA_VERSION_OVERRIDE", "0.10.0")

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # agent 自身：只传 dist 与容器专用清单。容器侧清单**不声明依赖**（只要
        # `type: module`）—— 框架本体走下面的 vendor，不走安装（见 README 第六节第 1 条）。
        await environment.upload_dir(PROJECT_DIR / "dist", f"{REMOTE_DIR}/dist")
        await environment.upload_file(
            PROJECT_DIR / "container-package.json", f"{REMOTE_DIR}/package.json"
        )

        # ⚠️ 不要在这里 `npm install`。踩过两次，都是同一个根因：
        #   ① 任务镜像没有 node ⇒ `npm install` exit 127；
        #   ② 补上 node 后，`npm install` 去 registry 拉 `@migor/agentia` 又
        #      `ERR_SOCKET_TIMEOUT`（容器出网时快时慢），Harbor 一律报成
        #      `NonZeroAgentExitCodeError` —— 看着像 agent 崩了，其实没到 agent。
        # 但框架是**零运行时依赖**：`npm install` 唯一要拉的就是框架本体本身。
        # ⇒ 把工作区里构建好的包按「发布态布局」直接搬进 node_modules，全程离线、
        #   也不受 registry 抖动影响，`npm` 这个依赖整个去掉。
        with tempfile.TemporaryDirectory(prefix="agentia-vendor-") as tmp:
            staging = Path(tmp)
            self._vendor_package(staging)
            await environment.upload_dir(
                staging / "node_modules", f"{REMOTE_DIR}/node_modules"
            )

        # 运行时（node）不是框架的依赖，是**任务的镜像**缺 —— 装在这里而不是改镜像
        # （改镜像就动了评测基准，分数不可比）。装载逻辑单独成脚本：
        # 它踩过两个坑（镜像没 node / 老 Debian 的 apt 装 nodejs 会 404），
        # 坑的形状与兜底链写在 `scripts/container-install-runtime.sh` 里，这里只负责调用。
        await environment.upload_file(
            PROJECT_DIR / "scripts" / "container-install-runtime.sh",
            f"{REMOTE_DIR}/.install-runtime.sh",
        )
        # 一次调用走完「装 node → 补可信根 → 装载自证 → TLS 自检」：四步的顺序与判据
        # 全在脚本里（那里能写注释、能本地 `sh -n`），Python 侧只负责调用与收尾解析。
        result = await self.exec_as_agent(
            environment,
            command=f"cd {shlex.quote(str(REMOTE_DIR))} && sh .install-runtime.sh",
            # TLS 自检要打 agent **真正要用的**那个端点 —— 打到别处等于没检查。
            env={"AGENTIA_TLS_CHECK_URL": self._tls_check_url()},
        )
        self._node_bin = self._parse_node_bin(getattr(result, "stdout", None) or "")
        if self._node_bin:
            print(f"[agentia] 运行时 node = {self._node_bin}")
        else:
            print(
                f"[agentia] 警告：装载脚本没有回传 {NODE_BIN_MARKER}… 标记，"
                "run 阶段会退回 PATH 上的 node（bun 系镜像上那里是 bun 的兼容壳）"
            )

    @staticmethod
    def _parse_node_bin(stdout: str) -> str | None:
        """从装载脚本的 stdout 里取回 `AGENTIA_NODE_BIN=<绝对路径>`。

        取**最后一行**：脚本是幂等的、可能被重跑，最后一行才是本次的结果。
        """
        for line in reversed(stdout.splitlines()):
            if line.startswith(NODE_BIN_MARKER):
                return line[len(NODE_BIN_MARKER) :].strip() or None
        return None

    def _tls_check_url(self) -> str:
        """推导模型端点的「能证明 TLS 通」的 URL（4xx 也算通，只看握手）。

        依据的是 `src/model.ts` 的那套 env 约定（`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`）；
        不在这里复制一份「用哪家模型」的判据，只把它的端点翻译成一个可探的 URL。

        ⚠️ **端点必须取自「要注入 agent 的那份 env」，不是宿主进程的 `os.environ`。**
        README 推荐的跑法是 `--ae DEEPSEEK_API_KEY=…`，这个值只落在 agent 的
        `extra_env` 上 ⇒ 只看 `os.environ` 会读不到 key，**静默**回落到 Anthropic 的端点
        ⇒ 探了一个跟本次跑无关的第三方端点。实测代价：同一轮 10 条里有 2 条因此被
        记成 `NonZeroAgentExitCodeError`（自检 `ECONNRESET`），其中一条是本该算数的
        已解出任务 —— 而且它长得像「环境问题」，不去翻 install 日志就只会以为机器抽风。

        取值顺序与 Harbor 自己的 `BaseAgent._env_sources()` 一致：agent env 覆盖宿主 env。
        """
        env = {**os.environ, **self.extra_env}
        base = env.get("DEEPSEEK_BASE_URL")
        if base:
            return f"{base.rstrip('/')}/models"
        if env.get("DEEPSEEK_API_KEY"):
            return "https://api.deepseek.com/models"
        # 不给 key 时走框架默认（Anthropic）；端点只是用来验 TLS，401 无妨。
        return "https://api.anthropic.com/v1/models"

    @staticmethod
    def _vendor_package(dest: Path) -> None:
        """把工作区里构建好的 `@migor/agentia` 摆成发布态布局（= `npm pack` 的内容）。

        只取 `files` 声明的两样：`dist/` 与 `package.json`（`files` 里的 CHANGELOG 对
        运行没意义，跳过）。这等价于把 registry 上那个 tarball 解开，但**不联网**。
        """
        dist = PKG_ROOT / "dist"
        manifest = PKG_ROOT / "package.json"
        if not (dist / "index.js").is_file():
            raise RuntimeError(
                f"找不到构建产物 {dist}/index.js —— 先在仓库根跑 `npm run build`，"
                "或用 AGENTIA_PKG_ROOT 指向一个已构建的工作区。"
            )
        target = dest / "node_modules" / "@migor" / "agentia"
        target.mkdir(parents=True)
        shutil.copytree(dist, target / "dist")
        shutil.copy2(manifest, target / "package.json")

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # 指令落盘再传路径：命令行里塞整段指令会撞引号转义（学 eve 的做法）
        with tempfile.TemporaryDirectory(prefix="agentia-instruction-") as tmp:
            local = Path(tmp) / "instruction.txt"
            local.write_text(instruction)
            await environment.upload_file(local, str(INSTRUCTION_PATH))

        logs_dir = self.environment_logs_dir or PurePosixPath("/logs/agent")
        await self._ensure_logs_dir(environment, logs_dir)
        env: dict[str, str] = {
            "AGENTIA_TB_INSTRUCTION": str(INSTRUCTION_PATH),
            "AGENTIA_ATIF_OUT": f"{logs_dir}/trajectory.json",
        }
        if self.model_name:
            env["AGENTIA_MODEL"] = self.model_name
        for key in SECRET_ENV_KEYS:
            value = os.environ.get(key)
            if value:
                env[key] = value

        # 走 install 阶段解析出的**绝对路径**，别让 bun 的兼容壳接走（脚本里的「坑四」）。
        # `"node"` 这个兜底只在 install 没回传标记时才用到（正常流程不会）。
        await self.exec_as_agent(
            environment,
            command=(
                f"cd {shlex.quote(str(REMOTE_DIR))} && "
                f"{shlex.quote(self._node_bin or 'node')} dist/run.js"
            ),
            env=env,
        )

    @staticmethod
    async def _ensure_logs_dir(environment: BaseEnvironment, logs_dir: PurePosixPath) -> None:
        """确保 ATIF 要落的目录**对 agent 用户可写**。

        多数任务镜像以 root 跑，`/logs` 直接建在 `/` 下即可。但 4.0 里有**非 root 任务**
        （Dockerfile 写 `USER nobody` / `USER agent`）且其中两题**没有**建 `/logs`：
        实测 `USER nobody` 的容器里 `/opt`、`/usr/local`、`$HOME`(=/nonexistent) 全不可写，
        `/logs` 也不存在 ⇒ 直接写 ATIF 会 EACCES，把可跑的 trial 变成一条异常。

        所以：先以 agent 身份试建；不成就**以 root 建好再把权限放宽**。
        `/logs/agent` 是 **Harbor 的 agent 日志契约目录**，不是任务的评分区 ——
        非 root 任务没提供它，补上是我们这边的责任（官方适配器也自己 `mkdir -p`，
        见 harbor 的 `gemini_cli.py`）。这里不碰 `/logs/verifier` 与任务的任何交付路径。
        """
        quoted = shlex.quote(logs_dir.as_posix())
        try:
            result = await environment.exec(f"mkdir -p {quoted} && [ -w {quoted} ]")
            if result.return_code == 0:
                return
        except Exception:  # noqa: BLE001 —— 探不动就往下走 root 兜底
            pass
        try:
            # 0777 不是手滑：这是短暂的评测容器里、只放我们自己轨迹的目录，
            # 而 agent 用户的 uid 在任务镜像里是什么我们并不知道（nobody 65534 / agent 1000 都见过）。
            await environment.exec(
                f"mkdir -p {quoted} && chmod 0777 {quoted}", user="root"
            )
            print(f"[agentia] 非 root 镜像：已由 root 建好可写的 {logs_dir}")
        except Exception as exc:  # noqa: BLE001 —— 兜底失败不在这里判死刑
            print(f"[agentia] 警告：{logs_dir} 可能不可写（{exc}），轨迹落盘会如实报错")
