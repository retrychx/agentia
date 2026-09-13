# syntax=docker/dockerfile:1
# Agentia 完整示例 —— 多阶段构建。
#
# ⚠️ 构建上下文 = **仓库根**（不是本目录）：框架当前版本尚未发布到 npm，
#    所以镜像里先从源码构建框架，再构建应用。
#
#   docker build -f examples/complete/Dockerfile -t agentia-complete .
#   docker compose -f examples/complete/docker-compose.yml up --build
#
# 框架发布后，把应用 package.json 的依赖从 `file:../..` 改成 `^0.2.2`，
# 即可退回常规单包 Dockerfile（`npm install && npm run build`）。

# ---------- 构建期：框架 → 应用 ----------
FROM node:24-slim AS build
WORKDIR /repo

# 1) 框架本体。它零运行时依赖（@anthropic-ai/sdk 全是 import type，编译后不留），
#    这里装的是构建期的 tsc。
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm install --no-audit --no-fund \
 && npm run build

# 2) 示例应用。它的依赖 `file:../..` 指向 /repo —— 上面刚构建出的 dist。
COPY examples ./examples
WORKDIR /repo/examples/complete
# --install-links：file: 依赖按普通包**拷贝**而非软链，运行期 stage 才能整体搬运
RUN npm install --install-links --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

# ---------- 运行期：只带产物（无 tsx / typescript） ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/examples/complete/node_modules ./node_modules
COPY --from=build /repo/examples/complete/dist ./dist
COPY --from=build /repo/examples/complete/package.json ./package.json

# 数据卷（SQLite 库 + WAL 文件），非 root 运行
RUN mkdir -p /data && chown node:node /data
ENV AGENTIA_DB=/data/agentia.db \
    PORT=3000
VOLUME ["/data"]
EXPOSE 3000

USER node
CMD ["node", "dist/main.js"]
