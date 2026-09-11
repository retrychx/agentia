#!/usr/bin/env python3
"""离线夹具 MCP server（stdlib only，无外部依赖）。

为什么有这个文件：`scripts/e2e-mcp.ts` 优先接**真第三方 server**（`uvx mcp-server-time`），
但 CI / 无网机器上拿不到它。这份夹具实现同一套协议面（initialize / tools/list / tools/call），
让端到端证明在离线环境里也能跑通（协议路径完全一致，只是数据是本地造的）。

用法：作为 stdio MCP server 启动（由 e2e 脚本 spawn），不需要参数。
"""
import json
import sys
from datetime import datetime, timezone, timedelta

TOOLS = [
    {
        "name": "get-current_time",  # 故意带 '-'：验证桥的名字归一化（对 LLM API 不友好）
        "description": "取某时区的当前时间（夹具实现）",
        "inputSchema": {
            "type": "object",
            "properties": {"timezone": {"type": "string", "description": "IANA 时区名，如 Asia/Shanghai"}},
            "required": ["timezone"],
            "additionalProperties": False,
        },
    }
]

OFFSETS = {
    "Asia/Shanghai": 8,
    "UTC": 0,
    "America/New_York": -4,
}


def reply(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def call_tool(name, arguments):
    if name != "get-current_time":
        return {"content": [{"type": "text", "text": f"未知工具 {name}"}], "isError": True}
    tz = (arguments or {}).get("timezone")
    if tz not in OFFSETS:
        # 协议层错误由连接器转成抛错（见 integrations/mcp.ts 的约定）
        return {"content": [{"type": "text", "text": f"不支持的时区 {tz!r}"}], "isError": True}
    now = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=OFFSETS[tz])))
    payload = {"timezone": tz, "datetime": now.isoformat(timespec="seconds"), "fixture": True}
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}], "isError": False}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = msg.get("method")
        id_ = msg.get("id")
        if method == "initialize":
            reply(id_, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "agentia-fixture", "version": "0.0.1"},
            })
        elif method == "notifications/initialized":
            pass  # 通知无响应
        elif method == "tools/list":
            reply(id_, {"tools": TOOLS})
        elif method == "tools/call":
            params = msg.get("params") or {}
            reply(id_, call_tool(params.get("name"), params.get("arguments")))
        elif id_ is not None:
            reply(id_, error={"code": -32601, "message": f"未实现方法 {method}"})


if __name__ == "__main__":
    main()
