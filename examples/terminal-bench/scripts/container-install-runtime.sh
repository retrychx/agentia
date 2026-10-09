#!/bin/sh
# 在**任务容器**里备好 agent 的运行时（node + 可信根证书）、做两次自证。
# 由 harbor_agent.py 上传后调用，**以 agent 用户身份**（不是 root）执行。
#
# 为什么单独成文件：这段逻辑踩过六个坑，坑的形状要写在一处、可本地 `sh -n` 检查，
# 不要塞进 Python f-string 里拼字符串。
#
# 坑一：任务镜像**不保证带 node**。官方任务镜像多是 `python-3-13` / `ubuntu-24-04` 这类，
#       没有 node ⇒ 直接跑 `node dist/run.js` 是 exit 127，Harbor 报成
#       NonZeroAgentExitCodeError，看着像「agent 代码错了」。
#
# 坑二：`apt-get install nodejs` **在老发行版上会 404**。实测两条 qemu 任务（Debian 11）：
#         E: Failed to fetch .../libnode72_12.22.12~dfsg-1~deb11u8_amd64.deb  404 Not Found
#       —— deb11 的安全更新早已被镜像下架，`apt-get update` 之后照样装不上。
#       ⇒ 必须有**不依赖发行版镜像**的兜底：官方静态包。
#
# 坑三（最阴的一个）：**装了 node 不等于能 HTTPS**。Ubuntu/Debian 的 nodejs 走
#       **系统根证书库**，而镜像可能压根没装 `ca-certificates` ⇒ 一个可信根都没有 ⇒
#       任何 TLS 都报 `SELF_SIGNED_CERT_IN_CHAIN`。实测对照（同一台机器、同一个 model key）：
#
#         regex-log（ubuntu:24.04，无 ca-certificates）  → fetch DeepSeek 全败，agent
#                                                          `stop=error error=connection`，
#                                                          0 token，reward=0
#         log-summary-date-ranges（debian:12，有 ca-certificates）→ 5/5 通，任务做对
#
#       ⇒ 分步实测确认因果：只装 nodejs 时 `SELF_SIGNED_CERT_IN_CHAIN` 且
#         `/etc/ssl/certs/ca-certificates.crt` **不存在**；补装 ca-certificates 后同一句
#         变成 `HTTP 401`（TLS 通了，401 只是没给 key）。
#       **这个坑的危害不在于失败，在于失败长得像「agent 不行」** —— 0 token 的 trial
#       会被算进平均分。所以最后一步做 TLS 自检，**自检不过就让 install 非零退出**，
#       把它推进 Harbor 的 exception 桶（而不是 reward=0 桶）。
#
# 坑四：**bun 系镜像里的 `node` 是 bun 的兼容壳，不是 node**。实测
#       `oven/bun:1.2.15-debian`：`/usr/local/bun-node-fallback-bin/node` 是 symlink →
#       `/usr/local/bin/bun`。在那里 `node --version` **rc=1**，并往 stderr 打一句
#       `error: Missing script to execute. Bun's provided 'node' cli wrapper does not support a repl.`
#       ⇒ 探测打出**空**版本、还把一句红字混进 install 日志；更糟的是
#       `node dist/run.js` 会拿 **bun 去跑一个 Node 框架**（不受支持的组合）。
#       判据用 `process.versions.bun` —— bun 下它打印自己的版本号，真 node 下是 undefined。
#       ⚠️ 而且**装上真 node 也不能靠 PATH**：bun 的壳排在 PATH 前面，`command -v node`
#       照样命中它（实测 `/usr/bin/node` 与 `/usr/local/bin/node` 都被它遮住）
#       ⇒ 脚本把解析出的**绝对路径**用下面那条 stdout 标记回传给 harbor_agent.py。
#       ⚠️ 刻意**不删** bun 那个壳：它是任务镜像自带的东西，删了就是动评测基准。
#
# 坑五：**发行版的 node 可能老到跑不了这个框架**。实测 `ubuntu:22.04` 的
#       `apt-get install nodejs` 给 **12.22.9**，而框架 `engines: node >= 18`。
#       危害不在「跑不起来」（那还是响的），在**它会先把自检脚本自己弄崩**：
#       `e.cause?.code ?? e.name` 这类 ES2020 语法在 node 12 上是 SyntaxError ⇒
#       自检脚本一行都没执行，却被下面的判据读成「TLS 不通」——
#       一个版本问题被报成网络问题，还把两道题推进了 exception 桶（2026-10-02 实测）。
#       ⇒ 两道防线：① 版本门 `major >= 18`，不够就换静态包；
#                 ② TLS 自检脚本**刻意只用 ES5**，并把 node 自己的 stderr 原样打出来。
#
# 坑六：**任务容器可能不是 root**。4.0 的 66 题里有 3 题 Dockerfile 写了 `USER nobody` / `USER agent`。
#       实测（`docker run -u nobody python:3.11-slim`）：
#         `/opt`、`/usr/local`、`$HOME`(=/nonexistent) 全部 DENIED；`/tmp` 可写。
#       更要紧的是**被上传的远端目录本身是 root 拥有的** —— Harbor 的上传走
#       `docker compose exec -T -u root … tar -xf`，所以 `/installed-agent/agentia-tb`
#       及其下的任何文件，agent 用户都写不进去。
#       ⇒ 两条纪律：① 安装前缀按可写性挑（`/opt` → `$HOME` → `/tmp`）；
#                 ② 脚本里**一个字节都不往远端目录写** —— 交接走 stdout 标记，
#                    装载自证走 `node -e`（实测：`-e` 的 ESM 裸名**按 cwd 解析**，
#                    所以 `cd` 到远端目录即可，不必落文件；旧注释说「必须落文件」是错的）。
#
# 输出契约（**唯一**一处交接，改这里就要同步 harbor_agent.py 的 `NODE_BIN_MARKER`）：
#   stdout 上最后回传一行 `AGENTIA_NODE_BIN=<node 的绝对路径>`。
#   为什么不写 `.node-bin` 文件：见坑六 ②，非 root 下那条路必挂。
#
# 顺序：node（已在 → apt → 静态包）→ 可信根 → 装载自证 → TLS 自检。幂等。
# ⚠️ 刻意不装 npm：agent 的依赖是「vendor 进 node_modules」的（见 harbor_agent.py），
#    运行时不需要 npm，装了只是多一次出网。

set -eu

NODE_DIST_VERSION="${NODE_DIST_VERSION:-v22.11.0}"
REAL_NODE_MIN_MAJOR="${REAL_NODE_MIN_MAJOR:-18}"
# TLS 自检的目标：默认打 agent 真正要用的模型端点（401 也算通，说明 TLS 没问题）。
TLS_CHECK_URL="${AGENTIA_TLS_CHECK_URL:-https://api.deepseek.com/models}"
CA_BUNDLE="/etc/ssl/certs/ca-certificates.crt"

# 自证要用 `node -e` 解析**裸包名**，而裸名的解析基是 **cwd**（`file://<cwd>/[eval]`）
# ⇒ 先站到脚本自己所在的目录 = 远端目录（里面有 node_modules）。
# 调用方本来就 `cd $REMOTE_DIR`，这里再兜一次，免得那一步被漏掉（坑六 ②）。
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------- 判据
# 「可用的 node」= 真 node（非 bun 兼容壳，坑四）**且** 版本够（坑五）。
is_usable_node() {
  [ -x "$1" ] || return 1
  "$1" -e '
var major = parseInt(String(process.versions.node).split(".")[0], 10);
if (process.versions.bun) process.exit(1);
process.exit(major >= parseInt(process.argv[1], 10) ? 0 : 2);
' "$REAL_NODE_MIN_MAJOR" >/dev/null 2>&1
}

node_version() {
  "$1" -e 'console.log(process.versions.node)' 2>/dev/null || echo '?'
}

NODE_BIN=""
# ⚠️ 不能写成 `[ ... ] && IS_ROOT=1`：判断为假时整条命令返回 1，`set -e` 会直接退出脚本。
IS_ROOT=""
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  IS_ROOT=1
fi
PATH_NODE="$(command -v node 2>/dev/null || true)"

# ---------------------------------------------------------------- 可信根（必须排在下载 node 之前）
# 见文件头「坑三」：没有 `ca-certificates.crt`，node 的 HTTPS 会 100% 报自签证书。
# ⚠️ 顺序：这一步**必须在装 node 之前** —— 静态包本身就是**从 HTTPS 下载**的。
# 实测 `ubuntu:22.04` 上顺序写反时 curl 直接
#   `curl: (77) error setting certificate file: /etc/ssl/certs/ca-certificates.crt`
# （文件根本不存在）⇒ 兜底路径在最小发行版上必挂。
if [ -f "$CA_BUNDLE" ]; then
  echo "[runtime] 可信根存在：$CA_BUNDLE"
elif [ -n "$IS_ROOT" ] && command -v apt-get >/dev/null 2>&1; then
  echo "[runtime] 缺可信根；装 ca-certificates"
  apt-get update -qq || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates || true
elif [ -n "$IS_ROOT" ] && command -v apk >/dev/null 2>&1; then
  echo "[runtime] 缺可信根；装 ca-certificates"
  apk add --no-cache ca-certificates || true
elif [ -n "$IS_ROOT" ] && command -v dnf >/dev/null 2>&1; then
  echo "[runtime] 缺可信根；装 ca-certificates"
  dnf install -y ca-certificates || true
else
  echo "[runtime] 警告：没有 $CA_BUNDLE，当前身份也补不了（非 root / 无包管理器）—— 若下面的下载或 TLS 自检失败就是这个原因" >&2
fi

if [ -n "$PATH_NODE" ] && is_usable_node "$PATH_NODE"; then
  NODE_BIN="$PATH_NODE"
  echo "[runtime] PATH 上已有可用的 node：$NODE_BIN ($(node_version "$NODE_BIN"))"
else
  if [ -n "$PATH_NODE" ]; then
    echo "[runtime] PATH 上的 node 不可用：$PATH_NODE → $(readlink -f "$PATH_NODE" 2>/dev/null || echo '?')"
    echo "[runtime]   版本 $(node_version "$PATH_NODE")；判据 = 真 node（非 bun 壳，坑四）且 major >= $REAL_NODE_MIN_MAJOR（坑五）"
  else
    echo "[runtime] PATH 上没有 node"
  fi

  # 包管理器只有 root 能用。非 root 下跑会刷一屏 `Permission denied`（坑六），
  # 既没用又把日志弄脏 ⇒ 直接跳过。
  if [ -n "$IS_ROOT" ]; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nodejs || true
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache nodejs || true
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y nodejs || true
    fi
  else
    echo "[runtime] 非 root（uid=$(id -u)）：跳过发行版包管理，直接走静态包（坑六）"
  fi

  # 显式按**绝对路径**找，不走 PATH —— bun 的壳会把 `command -v node` 抢走（坑四）。
  for cand in /usr/bin/node /usr/local/bin/node; do
    if is_usable_node "$cand"; then
      NODE_BIN="$cand"
      echo "[runtime] 发行版包可用：$NODE_BIN ($(node_version "$NODE_BIN"))"
      break
    fi
  done

  if [ -z "$NODE_BIN" ]; then
    # 兜底：官方静态包。用 python3/curl/wget 里**能用的那个**下载
    # （两个 TB 基础镜像都没有 curl，python3 反而是公约数），用 .tar.gz 而不是 .tar.xz：
    # 解压只需要 tar，不必依赖 xz-utils。
    echo "[runtime] 没有可用的系统 node；下载官方静态包 ${NODE_DIST_VERSION}"
    TARBALL="/tmp/node-${NODE_DIST_VERSION}-linux-x64.tar.gz"
    # 下载源：官方在前，然后两个国内镜像。可用 NODE_DIST_MIRROR 指定单一源覆盖。
    #
    # ⚠️ 为什么不能只靠「重试官方」：实测本机网络对 **`nodejs.org` 与
    #    `registry.npmjs.org` 做 TLS 中间人**（python / curl 一律
    #    `certificate verify failed: self-signed certificate`；同一个容器里
    #    `github.com` / `api.deepseek.com` / 三个国内镜像站全部 200）。
    #    也就是说这是**策略性拦断，不是抖动** —— 重试官方永远不会通。
    #    顺序保留官方在前：能直连的环境行为完全不变，直连不了的才落到镜像。
    #    （`registry.npmjs.org` 同一个坑还砸过 `nextjs-performance` 的 `npm ci`，见 README 坑 12。）
    if [ -n "${NODE_DIST_MIRROR:-}" ]; then
      NODE_SOURCES="${NODE_DIST_MIRROR%/}"
    else
      NODE_SOURCES="https://nodejs.org/dist/${NODE_DIST_VERSION}
https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/${NODE_DIST_VERSION}
https://npmmirror.com/mirrors/node/${NODE_DIST_VERSION}"
    fi

    # 最小发行版（`ubuntu:22.04` 这类）**三个下载工具一个都没有**，而版本门一旦把老 node
    # 挡掉，就只剩静态包这条路 ⇒ 没有下载工具 = 必挂。只有 root 装得动，非 root 走到这里
    # 只能如实报错（下面的 download 会兜）。装的是 curl，不是 node —— 不碰评测基准。
    if ! command -v python3 >/dev/null 2>&1 \
      && ! command -v curl >/dev/null 2>&1 \
      && ! command -v wget >/dev/null 2>&1 \
      && [ -n "$IS_ROOT" ]; then
      echo "[runtime] 没有任何下载工具，先装一个 curl"
      if command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl || true
      elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache curl || true
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y curl || true
      fi
    fi

    download() {
      if command -v python3 >/dev/null 2>&1; then
        python3 - "$1" "$2" <<'PY'
import sys, time, urllib.request

url, out = sys.argv[1], sys.argv[2]
# 重试是必需的，不是保险：实测容器出网**时快时慢**（同一 URL 第 1 次 SSL EOF、
# 第 2 次 200）。53MB 的包单次失败概率不低，单次尝试会让 trial 无谓地挂掉。
last = None
for attempt in range(1, 4):
    try:
        # 逐块下载 + 显式超时：默认无超时会让这里静默挂死。
        with urllib.request.urlopen(url, timeout=60) as resp, open(out, "wb") as fh:
            while chunk := resp.read(1 << 20):
                fh.write(chunk)
        print(f"downloaded {out} (attempt {attempt})")
        break
    except Exception as exc:  # noqa: BLE001 —— 网络层什么都可能抛，一律重试
        last = exc
        print(f"attempt {attempt} failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        time.sleep(2 * attempt)
else:
    raise SystemExit(f"download failed after 3 attempts: {last}")
PY
      elif command -v curl >/dev/null 2>&1; then
        curl -fL --retry 3 --connect-timeout 30 -o "$2" "$1"
      elif command -v wget >/dev/null 2>&1; then
        wget -T 30 -t 3 -O "$2" "$1"
      else
        echo "[runtime] 没有任何下载工具（python3 / curl / wget 都缺），无法兜底" >&2
        exit 1
      fi
    }

    # 逐个源试。`download` 已经自带 3 次重试（对付抖动），这一层对付的是「策略性拦断」。
    #
    # ⚠️ 完整性校验**不是可选项**：包来自镜像站（坑 11 已实测这条链路上有 TLS 中间人），
    # 不核 sha256 的话「下载成功」不等于「下的是 node」。每个源的目录结构与官方一致
    # （同源分发，SHASUMS256.txt 都在版本目录下）⇒ 同一份校验逻辑通用。
    # 校验失败 / 拿不到校验和 ⇒ 换下一个源；所有源都过不了 ⇒ fail（不装来路不明的 node）。
    sha256_of() { # $1=文件；stdout 出 hex 摘要。工具链按可得性挑，一个都没有 ⇒ 返回 1
      if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
      elif command -v python3 >/dev/null 2>&1; then
        python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"
      elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | awk '{print $NF}'
      else
        return 1
      fi
    }

    SUMS="/tmp/SHASUMS256-${NODE_DIST_VERSION}.txt"
    GOT=""
    for base in $NODE_SOURCES; do
      URL="${base}/node-${NODE_DIST_VERSION}-linux-x64.tar.gz"
      rm -f "$TARBALL" "$SUMS"
      if ! download "$URL" "$TARBALL"; then
        echo "[runtime] 这个源拿不到（换下一个）：$URL" >&2
        continue
      fi
      if ! download "${base}/SHASUMS256.txt" "$SUMS"; then
        echo "[runtime] 这个源拿不到 SHASUMS256.txt，无法校验（换下一个）：$base" >&2
        continue
      fi
      EXPECTED="$(awk -v f="node-${NODE_DIST_VERSION}-linux-x64.tar.gz" '$2 == f {print $1}' "$SUMS")"
      if [ -z "$EXPECTED" ]; then
        echo "[runtime] SHASUMS256.txt 里没有 ${NODE_DIST_VERSION} 的条目（换下一个源）：$base" >&2
        continue
      fi
      ACTUAL="$(sha256_of "$TARBALL" 2>/dev/null || true)"
      if [ -z "$ACTUAL" ]; then
        echo "[runtime] 容器里没有可用的 sha256 工具（sha256sum / python3 / openssl 都缺），拒绝不校验就装" >&2
        exit 1
      fi
      if [ "$EXPECTED" != "$ACTUAL" ]; then
        echo "[runtime] ⚠️ sha256 不符（换下一个源）：$URL" >&2
        echo "[runtime]   期望 $EXPECTED" >&2
        echo "[runtime]   实际 $ACTUAL" >&2
        continue
      fi
      GOT="$URL"
      break
    done
    [ -n "$GOT" ] || {
      echo "[runtime] 所有下载源都失败或没通过 sha256 校验；最后一个试的是 $URL" >&2
      exit 1
    }
    rm -f "$SUMS"
    echo "[runtime] 静态包来自：$GOT（sha256 已核）"

    # 安装前缀必须**自己可写**：非 root 容器里 /opt 与 $HOME 都可能写不了（坑六实测：
    # `USER nobody` 时 `/opt` / `/usr/local` 全 DENIED 且 `HOME=/nonexistent`）。
    # 刻意不试 /usr/local：/usr/local/bin 抢不过 bun 的壳（坑四实测）。
    NODE_PREFIX=""
    for cand in /opt/agentia-node "${HOME:-/nonexistent}/.agentia-node" /tmp/agentia-node; do
      if mkdir -p "$cand" 2>/dev/null && [ -w "$cand" ]; then
        NODE_PREFIX="$cand"
        break
      fi
    done
    [ -n "$NODE_PREFIX" ] || {
      echo "[runtime] /opt、\$HOME、/tmp 三处都写不了，找不到可用的安装前缀" >&2
      exit 1
    }

    # --strip-components=1 把包里的 node-v<ver>-linux-x64/ 前缀剥掉 ⇒ $NODE_PREFIX/bin/node
    tar -xzf "$TARBALL" -C "$NODE_PREFIX" --strip-components=1
    rm -f "$TARBALL"
    NODE_BIN="$NODE_PREFIX/bin/node"
    is_usable_node "$NODE_BIN" || {
      echo "[runtime] 静态包解出来的 node 仍不可用：$NODE_BIN（$(node_version "$NODE_BIN")）" >&2
      exit 1
    }
    echo "[runtime] 静态包安装完成：$NODE_BIN ($(node_version "$NODE_BIN"))"
  fi
fi

[ -n "$NODE_BIN" ] || {
  echo "[runtime] 没能解析出可用的真 node —— 拒绝用 bun 的壳去跑被测 agent" >&2
  exit 1
}

# 交接（契约见文件头）：harbor_agent.py 从 stdout 里捞这一行，供**下一步**（另起 shell）使用。
echo "AGENTIA_NODE_BIN=$NODE_BIN"

# ---------------------------------------------------------------- 装载自证
# 「搬进来的包能不能 import」在这里当场失败，而不是等 agent 跑起来才炸成
# NonZeroAgentExitCodeError（那要再花十几分钟才知道不是 agent 的锅）。
# ⚠️ 用 `-e` 而不是写个 `.mjs`：非 root 下往远端目录写文件必挂（坑六 ②）。
#    裸包名按 cwd 解析，所以上面那个 `cd` 是这一步的前提。
echo "[runtime] 装载自证：import('@migor/agentia')"
"$NODE_BIN" -e 'import("@migor/agentia").then(function (m) {
  console.log("[runtime] agentia loaded " + m.AGENTIA_VERSION);
}).catch(function (e) {
  console.error("[runtime] LOAD FAILED: " + e.message);
  process.exit(1);
});'

# ---------------------------------------------------------------- TLS 自检
# 目的不是「保证成功」，而是**让失败在正确的地方发生**：
# 不过就非零退出 ⇒ Harbor 记为 exception（基础设施），而不是 reward=0（看着像 agent 不行）。
#
# ⚠️ 这段**刻意只用 ES5**（不用 `?.` / `??` / 箭头函数 / 模板串）：它可能是整个脚本里
#    唯一在**版本未知**的 node 上执行的代码，而它的职责之一恰恰是把「版本不对」说清楚。
#    实测反例：`e.cause?.code ?? e.name` 在 node 12.22.9 上是 SyntaxError ⇒ 自检一行没跑，
#    却报成「TLS 不通」（坑五）。ES5 写法在任何 node 上至少能解析出来。
echo "[runtime] TLS 自检：$TLS_CHECK_URL（判据 = 握手能成，HTTP 几几都算通）"
TLS_ERR="$(mktemp 2>/dev/null || echo /tmp/.agentia-tls-selfcheck.err)"
if "$NODE_BIN" -e '
var url = process.argv[1];
var tries = 0;
function attempt() {
  tries++;
  var opts = { method: "HEAD" };
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    opts.signal = AbortSignal.timeout(20000);
  }
  fetch(url, opts).then(function (r) {
    console.log("[runtime] TLS OK (HTTP " + r.status + ")");
    process.exit(0);
  }).catch(function (e) {
    var code = (e && e.cause && e.cause.code) || (e && e.name) || String(e);
    if (tries >= 3) {
      console.error("[runtime] TLS self-check FAILED after 3 tries: " + code);
      process.exit(1);
    }
    console.error("[runtime] TLS try " + tries + " failed: " + code);
    setTimeout(attempt, 1500);
  });
}
attempt();
' "$TLS_CHECK_URL" 2>"$TLS_ERR"; then
  sed 's/^/[runtime] /' "$TLS_ERR" 2>/dev/null || true
  rm -f "$TLS_ERR"
else
  # 把 node 自己的 stderr 原样打出来 —— 否则「TLS 不通」会是一句**可能不成立的判断**
  # （语法错、版本太老、缺 fetch 都长得一样）。判据留给读日志的人，别替他下结论。
  echo "[runtime] node 自己的 stderr：" >&2
  sed 's/^/[runtime]   /' "$TLS_ERR" 2>/dev/null >&2 || true
  rm -f "$TLS_ERR"
  echo "[runtime] 解读：SyntaxError / ReferenceError: fetch ⇒ 这个 node 版本跑不了自检（不是网络）；" >&2
  echo "[runtime]       SELF_SIGNED_CERT_IN_CHAIN / UNABLE_TO_VERIFY ⇒ 容器缺可信根 $CA_BUNDLE；" >&2
  echo "[runtime]       ENOTFOUND / ECONNREFUSED / ETIMEDOUT ⇒ 容器出网不通。" >&2
  echo "[runtime] 故意在这里失败：让 Harbor 记成基础设施异常，不要伪装成 agent 的 0 分。" >&2
  exit 1
fi
