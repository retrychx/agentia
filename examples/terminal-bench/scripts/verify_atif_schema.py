"""
用 Harbor **自己那份** ATIF 模型校验 `src/selftest.ts` 产出的轨迹。

为什么不用自己写的 JSON Schema 校验：ATIF 有三条约束是「读代码看不出来、线上才会炸」的
（`harbor/models/trajectories/trajectory.py` 的模型验证器）：

  1. `steps[].step_id` 必须从 1 连续；
  2. `observation.results[].source_call_id` 必须命中**同一步** `tool_calls[].tool_call_id`；
  3. 根对象 `extra="forbid"` —— 多一个字段直接判非法。

自己抄一份 Schema 等于把「和上游对齐」这件事变成第二个会腐烂的副本。
所以这里直接用装好的 harbor 包。

用法（harbor 用 uv tool 装在自己的 venv 里，要用它那个解释器）：

    HBP=~/.local/bin/harbor          # 或者 uv tool dir 里的 bin/python
    <harbor 的 python> scripts/verify_atif_schema.py [轨迹路径]

退出码：0 = 通过；1 = 非法（会打印 pydantic 的逐条报错）；2 = 环境不对（没装 harbor）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "out" / "atif-sample.json"


def main() -> int:
    try:
        from harbor.models.trajectories import Trajectory
    except ModuleNotFoundError:
        print(
            "没找到 harbor。装它：uv tool install harbor；\n"
            "并用它的解释器跑本脚本（见文件头用法）。",
            file=sys.stderr,
        )
        return 2

    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PATH
    if not path.is_file():
        print(f"轨迹文件不存在：{path}\n先跑：npm run selftest", file=sys.stderr)
        return 2

    payload = json.loads(path.read_text())
    try:
        traj = Trajectory.model_validate(payload)
    except Exception as exc:  # pydantic 的 ValidationError 自带逐条定位
        print(f"ATIF 非法：\n{exc}", file=sys.stderr)
        return 1

    tool_calls = sum(len(s.tool_calls or []) for s in traj.steps)
    observations = sum(len(s.observation.results) if s.observation else 0 for s in traj.steps)
    print(f"ATIF 合法：{path}")
    print(f"  schema_version = {traj.schema_version}")
    print(f"  agent          = {traj.agent.name}@{traj.agent.version} model={traj.agent.model_name}")
    print(f"  steps={len(traj.steps)} tool_calls={tool_calls} observations={observations}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
