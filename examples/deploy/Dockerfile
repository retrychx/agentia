# syntax=docker/dockerfile:1
# Agentia 部署示例 —— 多阶段构建。
# 构建：docker build -t agentia-deploy-example examples/deploy
# 运行：docker compose -f examples/deploy/docker-compose.yml up --build
#
# 说明：本示例的 /healthz 是探针端点（框架不鉴权），drain 超时 15s → 下方 compose 的
# stop_grace_period 必须大于它，优雅停机才跑得完。

# ---------- 构建期：装全部依赖 + 编译 TS ----------
FROM node:24-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行期：只带产物 + 运行期依赖 ----------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 只装运行期依赖（@migor/agentia），构建工具不进最终镜像
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# 数据卷：SQLite 库（WAL 模式下 ≤3 个文件），非 root 运行
RUN mkdir -p /data && chown node:node /data
ENV AGENTIA_DB=/data/agentia.db \
    PORT=3000
VOLUME ["/data"]
EXPOSE 3000

USER node
CMD ["node", "dist/main.js"]
