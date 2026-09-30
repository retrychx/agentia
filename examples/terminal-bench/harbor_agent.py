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
        # 只传 dist 与容器专用清单：容器里没有工作区，`file:../..` 那个清单装不上
        # （container-package.json 用已发布的版本号，见 README「为什么有两份清单」）。
        await environment.upload_dir(PROJECT_DIR / "dist", f"{REMOTE_DIR}/dist")
        await environment.upload_file(
            PROJECT_DIR / "container-package.json", f"{REMOTE_DIR}/package.json"
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"cd {shlex.quote(str(REMOTE_DIR))} && "
                "npm install --omit=dev --no-audit --no-fund"
            ),
        )

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
