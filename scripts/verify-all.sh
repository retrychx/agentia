#!/bin/bash
# Agentia 全链验证：逐步骤检查退出码（不用 `cmd && echo` —— 那样会吞掉失败）
set -uo pipefail
# 从脚本位置推仓库根 —— 不要硬编码绝对路径（CI / 他人机器上必挂）
cd "$(dirname "$0")/.."

# ⚠️ 本脚本的**步骤数**写在 CI 的 job 名里 —— 而那个名字就是分支保护里的必需状态检查
#    「全链验证（verify-all 8 步）」。加/减一步都得同时改 workflow 的 job name **和** 分支保护，
#    否则 PR 会卡死等一个永不出现的检查。所以新增的检查一律**折进已有步骤**，不加步骤。
#
#    这次就是照这条规矩做的：lint 折进第 1 步，而不是变成第 9 步。
steps=(
  # 第 1 步 = 类型检查 + lint。lint 此前只活在 CI 的独立 job 里，本地这条链不跑它 ——
  # 于是「本地 8/8 全绿、CI 挂 Biome」**真的发生过**（2026-09-14：本地全绿，CI 的 lint job
  # 在新写的源码与测试上挂了 4 条格式 error）。折进已有步骤有两个好处：job 名不必改，
  # 且 lint 从此落在**必需检查**里面 —— 新开一个非必需 job 反而是更弱的保证。
  # 2026-09-20：从「只报 error」翻成**零告警**。此前 `npm run lint`/`biome ci` 都是
  # 「没 error 就绿」—— 存量 93 warnings + 12 infos 照样过闸门。翻严的配套：
  #   ① 存量清零（PR #84）；② info 级规则在 biome.jsonc 里升到 warn（--error-on-warnings
  #   **不管 info**）；③ 三处样式表用带理由的 biome-ignore-all 关掉误报型的 noDescendingSpecificity。
  "npm run typecheck && npx biome ci . --error-on-warnings"
  "npm run build"
  "npm run typecheck:types"
  "npm run typecheck:tests"
  "npm run build:cli"
  "npm test"
  "npm run e2e"
  # 第 8 步 = 构建官网 + **按产物形状**核 agent 可读性（404.html 硬 404 / robots+sitemap /
  # llms.txt 绝对链接与页面覆盖 / llms-full.txt 单源一致 / 每页 llms 指引形态）。
  # 折进本步而不是新开第 9 步 —— 理由见顶部注释（步骤数写在 CI 必需检查名里）。
  # 2026-09-21：这六类问题当时**全是线上实际存在的**，且没有一条是本仓测试能发现的
  #（源码绿、线上照样在骗 agent：soft 404 + 根相对 llms.txt 链接）。
  "npm run build:website && node scripts/check-website-agent-readiness.mjs"
)

fail=0
for s in "${steps[@]}"; do
  # ⚠️ 步骤经 `bash -c` 执行，**不要**写成 `if out=$($s 2>&1)`：$s 是词展开，
  #    里面的 shell 运算符（`&&`）不会生效，而是原样变成**命令的实参** ——
  #    第 1 步挤 `npm run typecheck && npx biome ci .` 时就成了
  #    `tsc --noEmit -p tsconfig.json "&&" "npx" "biome" "ci" "."` ⇒ TS5042。
  #    走 `bash -c` 后每个步骤就是一条完整的命令行，可以带 `&&`。
  if out=$(bash -c "$s" 2>&1); then
    echo "  OK   $s"
  else
    echo "  FAIL $s"
    # 失败定位：这里把整段输出捕获进了 $out，若只 tail 尾部，恰好会把
    # 「哪条测试挂了」的标记行冲掉 —— CI 上就只剩一个 exit 1，谁也查不出是谁。
    # 先按 node:test / tsc / biome 的标记抽出关键行，再补尾部上下文。
    # ⚠️ 除了**断言失败**，还有两类非断言的失败，只抓 `not ok` / `AssertionError` 会丢原因：
    #   ① 测试被 runner **cancel**（`failureType: cancelledByParent` + `Promise resolution is
    #      still pending but the event loop has already resolved`，统计里是 `# cancelled N`
    #      而 `# fail 0`）—— 2026-09-14 那次就是这么丢的；
    #   ② biome 的诊断（本地链现在也跑它）首行是
    #      `路径:行:列 lint/分类/规则  FIXABLE  ━━` 或 `路径 format ━━`，**不带 `✖`**
    #      （`✖ File content differs…` 在下一行）—— 只比对 `✖` 等于又丢一次文件名。
    echo "$out" |
      # biome 的诊断首行**带 ANSI 颜色码**（路径与 `format` 之间夹着 `\033[0m`），
      # 直接锚定「路径 format ━━」会失配 —— 先剥色再抽标记行。
      # 尾部上下文保持原样（CI 日志照样有颜色，只是我们匹配时不看它）。
      sed $'s/\033\\[[0-9;]*m//g' |
      grep -aE '✖|✗|not ok|# fail|# cancelled|AssertionError|error TS[0-9]+|Error:|✘|failureType|cancelledByParent|event loop has already resolved|Found [0-9]+ errors?|Some errors were emitted|^[^ ]+ +(format|lint|syntax|assist).*━' |
      head -20 | sed 's/^/    ➜ /'
    echo "$out" | tail -30 | sed 's/^/       /'
    fail=1
  fi
done

echo "------------------------------"
if [ $fail -eq 0 ]; then
  # 计数**算出来**而不是写死：写死的那个数字在加步骤后会变成假话（而这个数字与 CI 的 job 名
  # 是同一个约定，尤其不能各说各话）。
  echo "${#steps[@]}/${#steps[@]} 全绿"
  # 本地绿 ≠ CI 绿。这三个必需检查只跑在 CI，且**本地无法等价复现**（理由见 CONTRIBUTING 的坑表）：
  # e2e:mcp 优先接真第三方 server（需要网络/uv），导入下限只能跑在 Node 18/20 上 ——
  # scripts/check-import-floor.mjs 按运行中的 Node 分支，本地跑它验不到 18/20 那条路。
  # 不静默：全绿时明确说清「还有三个没在这里跑」。
  echo "ℹ 另有 3 个 CI 独有必需检查不在本链：e2e:mcp · 导入下限（Node 18 / 20）"
else
  echo "有步骤失败"
fi
exit $fail
