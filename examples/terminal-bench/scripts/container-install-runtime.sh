#!/bin/sh
# 在**任务容器**里备好 agent 的运行时（node + 可信根证书）。由 harbor_agent.py 上传后调用。
#
# 为什么单独成文件：这段逻辑踩过三个坑，坑的形状要写在一处、可本地 `sh -n` 检查，
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
# 顺序：node（已在 → apt → 静态包）+ 可信根，最后 TLS 自检。幂等。
# ⚠️ 刻意不装 npm：agent 的依赖是「vendor 进 node_modules」的（见 harbor_agent.py），
#    运行时不需要 npm，装了只是多一次出网。

set -eu

NODE_DIST_VERSION="${NODE_DIST_VERSION:-v22.11.0}"
# TLS 自检的目标：默认打 agent 真正要用的模型端点（401 也算通，说明 TLS 没问题）。
TLS_CHECK_URL="${AGENTIA_TLS_CHECK_URL:-https://api.deepseek.com/models}"
CA_BUNDLE="/etc/ssl/certs/ca-certificates.crt"

# ---------------------------------------------------------------- node
if command -v node >/dev/null 2>&1; then
  echo "[runtime] node already present: $(node --version)"
else
  echo "[runtime] node not found; trying distro package (fast path)"
  # `|| true`：装不上不是这里判死刑，交给下面的兜底；最后的 node --version 才是判据。
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nodejs || true
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs || true
  fi

  if command -v node >/dev/null 2>&1; then
    echo "[runtime] node installed from distro package: $(node --version)"
  else
    # 兜底：官方静态包。用 python3/curl/wget 里**能用的那个**下载
    # （两个 TB 基础镜像都没有 curl，python3 反而是公约数），用 .tar.gz 而不是 .tar.xz：
    # 解压只需要 tar，不必依赖 xz-utils。
    echo "[runtime] distro package unavailable; falling back to static build ${NODE_DIST_VERSION}"
    TARBALL="/tmp/node-${NODE_DIST_VERSION}-linux-x64.tar.gz"
    URL="https://nodejs.org/dist/${NODE_DIST_VERSION}/node-${NODE_DIST_VERSION}-linux-x64.tar.gz"

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

    download "$URL" "$TARBALL"
    # --strip-components=1 把包里的 node-v<ver>-linux-x64/ 前缀剥掉，直接落到 /usr/local
    tar -xzf "$TARBALL" -C /usr/local --strip-components=1
    rm -f "$TARBALL"
    echo "[runtime] node installed from static build: $(node --version)"
  fi
fi

# ---------------------------------------------------------------- 可信根
if [ -f "$CA_BUNDLE" ]; then
  echo "[runtime] CA bundle present: $CA_BUNDLE"
elif command -v apt-get >/dev/null 2>&1; then
  # 见文件头「坑三」：没有这个文件，node 的 HTTPS 会 100% 报自签证书。
  echo "[runtime] CA bundle missing; installing ca-certificates"
  apt-get update -qq || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates || true
else
  echo "[runtime] 警告：没有 $CA_BUNDLE，也没有 apt-get 可补 —— 若下面的 TLS 自检失败就是这个原因" >&2
fi

# ---------------------------------------------------------------- TLS 自检
# 目的不是「保证成功」，而是**让失败在正确的地方发生**：
# 不过就非零退出 ⇒ Harbor 记为 exception（基础设施），而不是 reward=0（看着像 agent 不行）。
echo "[runtime] TLS self-check: $TLS_CHECK_URL"
if node -e '
const url = process.argv[1];
(async () => {
  let last = "";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(20000) });
      // 4xx/5xx 都算「TLS 通」——我们要证明的是链子能握上手，不是接口有没有鉴权。
      console.log(`[runtime] TLS OK (HTTP ${r.status})`);
      process.exit(0);
    } catch (e) {
      last = e.cause?.code ?? e.name;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.error(`[runtime] TLS self-check FAILED after 3 tries: ${last}`);
  process.exit(1);
})();
' "$TLS_CHECK_URL"; then
  :
else
  echo "[runtime] 容器到模型端点的 HTTPS 不通。常见原因：镜像缺 $CA_BUNDLE（装不上就按上面手动补）。" >&2
  echo "[runtime] 故意在这里失败：让 Harbor 记成基础设施异常，不要伪装成 agent 的 0 分。" >&2
  exit 1
fi
