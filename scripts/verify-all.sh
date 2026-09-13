#!/bin/bash
# Agentia 全链验证：逐步骤检查退出码（不用 `cmd && echo` —— 那样会吞掉失败）
set -uo pipefail
# 从脚本位置推仓库根 —— 不要硬编码绝对路径（CI / 他人机器上必挂）
cd "$(dirname "$0")/.."

steps=(
  "npm run typecheck"
  "npm run build"
  "npm run typecheck:types"
  "npm run typecheck:tests"
  "npm run build:cli"
  "npm test"
  "npm run e2e"
  "npm run build:website"
)

fail=0
for s in "${steps[@]}"; do
  if out=$($s 2>&1); then
    echo "  OK   $s"
  else
    echo "  FAIL $s"
    # 失败定位：这里把整段输出捕获进了 $out，若只 tail 尾部，恰好会把
    # 「哪条测试挂了」的标记行冲掉 —— CI 上就只剩一个 exit 1，谁也查不出是谁。
    # 先按 node:test / tsc / 常见错误标记抽出关键行，再补尾部上下文。
    echo "$out" | grep -aE '✖|✗|not ok|# fail|AssertionError|error TS[0-9]+|Error:|✘' |
      head -20 | sed 's/^/    ➜ /'
    echo "$out" | tail -30 | sed 's/^/       /'
    fail=1
  fi
done

echo "------------------------------"
if [ $fail -eq 0 ]; then
  echo "8/8 全绿"
else
  echo "有步骤失败"
fi
exit $fail
