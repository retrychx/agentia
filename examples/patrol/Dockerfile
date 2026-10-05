# syntax=docker/dockerfile:1
# Agentia 巡检示例 —— 多阶段构建。
#
# ⚠️ 构建上下文 = **仓库根**（不是本目录）：示例刻意跑仓库里的框架源码，
#    所以镜像里先从源码构建框架，再构建应用。
#
#   docker build -f examples/patrol/Dockerfile -t agentia-patrol .
#   docker compose -f examples/patrol/docker-compose.yml up --build
#
# 想改用 npm 发布版：把应用 package.json 的依赖从 `file:../..` 改成 `^0.10.0`。

# ---------- 构建期：框架 → 应用 ----------
FROM node:24-slim AS build
WORKDIR /repo

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# npm run build 会跑 scripts/copy-assets.mjs —— 找不到 docs/usage-guide.md 就 exit 1
COPY docs ./docs
RUN npm install --no-audit --no-fund \
 && npm run build

COPY examples ./examples
WORKDIR /repo/examples/patrol
# --install-links：file: 依赖按普通包**拷贝**而非软链，运行期 stage 才能整体搬运
RUN npm install --install-links --no-audit --no-fund \
 && npm run build \
 && npm prune --omit=dev

# ---------- 运行期：只带产物（无 tsx / typescript） ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/examples/patrol/node_modules ./node_modules
COPY --from=build /repo/examples/patrol/dist ./dist
COPY --from=build /repo/examples/patrol/package.json ./package.json
# 巡检目标：默认带上示例工作区；生产请挂你自己的目录到 /workspace（只读）
COPY --from=build /repo/examples/patrol/sample-workspace ./sample-workspace

# 数据卷：SQLite 库 + 产出（报告 / 隔离区 / trace），非 root 运行
RUN mkdir -p /data && chown node:node /data
ENV PATROL_DB=/data/patrol.db \
    PATROL_REPORTS=/data/reports \
    PATROL_ROOT=/workspace \
    PORT=3000
VOLUME ["/data"]
EXPOSE 3000

USER node
CMD ["node", "dist/main.js"]
