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
        #
        # 末尾是「装载自证」：让「搬进来的包能不能 import」当场失败，而不是等到 agent
        # 跑起来才暴露成 `NonZeroAgentExitCodeError`（那要再花 10 分钟才知道不是 agent 的锅）。
        # ⚠️ 自证必须落成**文件**再跑，不能用 `node --input-type=module -e`：
        #   实测 `-e` 的 ESM 裸名不按 cwd 解析（报 Cannot find package），文件才会。
        #   且文件必须写在 REMOTE_DIR 里，才够得着同级的 node_modules。
        probe = (
            "import('@migor/agentia')"
            ".then(m => console.log('agentia loaded', m.AGENTIA_VERSION))"
            ".catch(e => { console.error('LOAD FAILED:', e.message); process.exit(1); });"
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"cd {shlex.quote(str(REMOTE_DIR))} && "
                "sh .install-runtime.sh && "
                f'printf "{probe}\\n" > .loadcheck.mjs && node .loadcheck.mjs'
            ),
            # TLS 自检要打 agent **真正要用的**那个端点 —— 打到别处等于没检查。
            env={"AGENTIA_TLS_CHECK_URL": self._tls_check_url()},
        )

    @staticmethod
    def _tls_check_url() -> str:
        """推导模型端点的「能证明 TLS 通」的 URL（4xx 也算通，只看握手）。

        依据的是 `src/model.ts` 的那套 env 约定；不在这里复制一份「用哪家模型」的判据，
        只把它的端点翻译成一个可探的 URL。
        """
        base = os.environ.get("DEEPSEEK_BASE_URL")
        if base:
            return f"{base.rstrip('/')}/models"
        if os.environ.get("DEEPSEEK_API_KEY"):
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

        await self.exec_as_agent(
            environment,
            command=f"cd {shlex.quote(str(REMOTE_DIR))} && node dist/run.js",
            env=env,
        )
