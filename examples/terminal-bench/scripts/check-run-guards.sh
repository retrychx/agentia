#!/usr/bin/env bash
#
# 离线检查 `src/run.ts` 的**三条守卫**（不需要 Docker、不需要真模型、不花钱）。
#
# 为什么值得单独一个脚本：这三条守卫的失败模式恰恰是「**悄悄不生效**」——
# 它们各自对应一种「看着像 agent 答错的 0 分」（见 README §六 坑 5 / 坑 6.1 / 坑 6.2）。
# 守卫要是哪天哑了，`reward.txt` 上一切照旧，没有任何东西会红。
# 而端到端验证一次真容器要几十分钟 + 几美元 ⇒ 没人会为了改一行守卫去跑它。
# 这里用**假端点**把五种收尾造出来，几十秒跑完，断言的是**进程退出码**。
#
# 五条断言的判据（都是「退出码」这种不会被伪装的东西）：
#   撞循环上限      ⇒ exit 3，stderr 有「掐断」字样，sidecar 的 truncated_by_harness = true
#   正常收尾        ⇒ exit 0，stderr 空，sidecar 的 truncated_by_harness = false
#   零 token        ⇒ exit 2（第一条守卫，**不能被新守卫遮住**）
#   持续 5xx        ⇒ exit 4，sidecar 的 infra_error = true（tokens > 0 ⇒ 零 token 守卫接不住）
#   上下文超长 400  ⇒ exit 4，infra_error = true（api 类里**唯一**算基础设施的子类）
#
# 用法：npm run check:guards   （或 bash scripts/check-run-guards.sh）
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-node}"
STUB="$HERE/scripts/stub-openai-endpoint.mjs"
FAIL=0

if [ ! -f "$HERE/dist/run.js" ]; then
  echo "先构建：npm run build（缺 $HERE/dist/run.js）" >&2
  exit 1
fi

run_case() { # $1=mode $2=maxIterations $3=期望退出码 $4=期望 truncated_by_harness
  local mode="$1" maxiter="$2" want_rc="$3" want_cut="$4"
  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/agentia-guard-XXXXXX")"

  MODE="$mode" "$NODE" "$STUB" > "$work/port.txt" 2> "$work/stub.err" &
  local stub_pid=$!
  local i
  for i in $(seq 1 50); do [ -s "$work/port.txt" ] && break; sleep 0.1; done
  local port
  port="$(sed -n 's/^PORT=//p' "$work/port.txt")"
  if [ -z "$port" ]; then
    echo "  ✗ 假端点没起来：$(cat "$work/stub.err")" >&2
    kill "$stub_pid" 2>/dev/null
    wait "$stub_pid" 2>/dev/null || true
    return 1
  fi

  printf '这是一个离线检查用的无害任务。\n' > "$work/instruction.txt"
  mkdir -p "$work/logs/agent"

  (
    cd "$HERE" || exit 9
    AGENTIA_TB_INSTRUCTION="$work/instruction.txt" \
    AGENTIA_ATIF_OUT="$work/logs/agent/trajectory.json" \
    AGENTIA_MAX_ITERATIONS="$maxiter" \
    AGENTIA_MODEL=deepseek-chat \
    DEEPSEEK_API_KEY=sk-offline-check \
    DEEPSEEK_BASE_URL="http://127.0.0.1:$port" \
    "$NODE" dist/run.js > "$work/stdout.txt" 2> "$work/stderr.txt"
  )
  local rc=$?
  kill "$stub_pid" 2>/dev/null
  wait "$stub_pid" 2>/dev/null || true   # 不等一下的话，bash 会把 TERM 当作业状态打到 stderr

  local got_cut got_stop got_infra
  got_cut="$("$NODE" -e "try{const s=require('$work/logs/agent/agentia-run-status.json');process.stdout.write(String(s.truncated_by_harness))}catch{process.stdout.write('MISSING')}")"
  got_stop="$("$NODE" -e "try{const s=require('$work/logs/agent/agentia-run-status.json');process.stdout.write(s.stop_reason)}catch{process.stdout.write('MISSING')}")"
  got_infra="$("$NODE" -e "try{const s=require('$work/logs/agent/agentia-run-status.json');process.stdout.write(String(s.infra_error))}catch{process.stdout.write('MISSING')}")"

  local label="MODE=$mode MAX_ITERATIONS=$maxiter"
  # ⚠️ 变量后面紧跟中文标点时必须写 `${x}`：`$x，` 会被 bash 当成一个变量名（实测 unbound variable）。
  if [ "$rc" = "$want_rc" ] && [ "$got_cut" = "$want_cut" ]; then
    echo "  ✓ ${label} ⇒ exit ${rc}，stop_reason=${got_stop}，truncated_by_harness=${got_cut}"
  else
    echo "  ✗ ${label} ⇒ exit ${rc}（期望 ${want_rc}），truncated_by_harness=${got_cut}（期望 ${want_cut}）"
    echo "      stderr: $(cat "$work/stderr.txt")"
    FAIL=1
  fi
  # 撞上限那条必须**留痕**：stderr 里没有可读的说明就等于没诊断
  if [ "$want_rc" = "3" ] && ! grep -q "掐断" "$work/stderr.txt"; then
    echo "      ✗ exit 3 但 stderr 里没有说明文字（exception_info 里就看不到原因了）"
    FAIL=1
  fi
  # 基础设施守卫同样要留痕，且 sidecar 的 infra_error 必须置真
  if [ "$want_rc" = "4" ]; then
    grep -q "基础设施" "$work/stderr.txt" || {
      echo "      ✗ exit 4 但 stderr 里没有说明文字：$(cat "$work/stderr.txt")"
      FAIL=1
    }
    [ "$got_infra" = "true" ] || {
      echo "      ✗ exit 4 但 sidecar 的 infra_error=${got_infra}（期望 true）"
      FAIL=1
    }
  fi
  [ "$want_rc" = "0" ] && [ -s "$work/stderr.txt" ] && {
    echo "      ✗ 正常收尾不应往 stderr 写东西：$(cat "$work/stderr.txt")"
    FAIL=1
  }
  rm -rf "$work"
  return 0
}

echo "== run.ts 守卫自检（假端点，不花钱）=="
run_case tool 1 3 true || FAIL=1
run_case text 5 0 false || FAIL=1
run_case zero 5 2 false || FAIL=1
run_case flaky500 50 4 false || FAIL=1
run_case ctx400 50 4 false || FAIL=1

if [ "$FAIL" != "0" ]; then
  echo "== 有断言没通过 =="
  exit 1
fi
echo "== 5/5 通过 =="
