# 脚手架默认入口改成服务（对齐 NestJS 口径）

> 撰写时刻：**2026-10-09**。来源：用户在 PR #224 评审后的一句话 —— 「我主要是想让框架 build
> 之后 run 起来可以直接用，参考 nestjs 服务口径」。
>
> 此前 #224 落成的形态是「`npm start` 仍是一次性 Job，**另外**给一个 `npm run start:server`」
> —— 那是「多给一个入口」，不是「默认跑起来就能用」。本稿把这两者反过来。
>
> 定位复核：本稿**零 `src/` 改动**（框架侧一个字节不动），全部落在 `packages/cli/{templates,src,test}`
> + `scripts/e2e-cli.ts` + `docs/` ⇒ 不违「不逼核心变厚」。

## 0. 一句话

把脚手架的**默认交付形态**从「批处理 CLI」翻成「HTTP 服务」：`npm run build` 之后 `npm start`
起来的就是一个在**监听**的服务（`/healthz` + 同步 `POST /run` + 异步 `POST /tasks` + 崩溃续跑 +
优雅停机）；一次性批处理挪到 `npm run start:batch`。

## 1. 现状（逐条核证过，带 file:line）

| # | 事实 | 出处 |
|---|---|---|
| 1 | 脚手架目前 `npm start` = `node dist/main.js` = **跑一次就退出** | `packages/cli/templates/package.json:8` |
| 2 | 服务在**另一个** script 上：`npm run start:server` = `node dist/server.js` | `packages/cli/templates/package.json:9` |
| 3 | `main.ts` 是「薄入口」：`createAgentApp()` → `app.run([...])` → 查 `result.error` → 打印 `finalText` | `packages/cli/templates/src/main.ts:7,9,13-19` |
| 4 | `server.ts` 是完整宿主：`createHttpHandler` + `AsyncRunner` + `SqliteTaskStore` + `resumePending` + `drain` + 可选 Bearer 鉴权 | `packages/cli/templates/src/server.ts:19,39-41,53-56,73-87` |
| 5 | 两者**共用** `app.ts` 的 `createAgentApp()` 工厂（`templates.test.mjs` 钉着「不许旁路 `createApp`」） | `packages/cli/templates/src/app.ts:71-98`；`packages/cli/test/templates.test.mjs:116-134` |
| 6 | 框架导出**四种** TaskStore：内存 / 文件（JSONL）/ SQLite / Redis | `src/index.ts:148,150,172,183` |
| 7 | `SqliteTaskStore` 用 `node:sqlite`（Node ≥22.5），**延迟加载**：低版本上 import 不崩、**构造期**抛可读报错 | `src/store/sqliteStore.ts:6-17` |
| 8 | `FileTaskStore` 是 JSONL 落盘、**单写者前提**（多进程共写会交错） | `src/store/fsStore.ts:22-24` |
| 9 | `.gitignore` 模板已经挡住 `agentia.db*` | `packages/cli/templates/gitignore:12` |
| 10 | `AGENTIA_DB` 缺省是 **cwd 相对**的 `'agentia.db'` | `packages/cli/templates/src/server.ts:23` |
| 11 | `PORT = Number(process.env.PORT ?? 3000)` ⇒ `PORT=`（空串）得 `0` ⇒ **静默随机端口** | `packages/cli/templates/src/server.ts:22` |
| 12 | `app.ts` 已经导出 `PROJECT_ROOT`，且明确「能力目录按**本文件位置**解析，别改回 cwd 相对写法」 | `packages/cli/templates/src/app.ts:44-45,59` |
| 13 | e2e 已经**真跑**这条路：4d 真跑 `npm run build`、4e 两头跑 `dist/main.js`、4f `PORT=0` 起 `dist/server.js` 打 `/healthz`→401→200→SIGTERM | `scripts/e2e-cli.ts:272,396-510` |
| 14 | §1 登记表有一行专门钉「`loadEnvFile()` 必须在 `app.ts` **且不在** `main.ts`」 | `docs/guards.md:130` |
| 15 | 使用者面文档把两个入口写成了表格两行 | `docs/usage-guide.md:104-105` |

⇒ 结论：**能力全都在了，缺的只是「哪个是默认」**。这不是新功能，是**默认值的翻转**。

## 2. 决策一：默认入口怎么摆 —— 换骨（而非换皮）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A 换骨（采用）** | 服务入口改成 `src/main.ts`；一次性挪去 `src/batch.ts`；`start` → 服务、`start:batch` → 一次性、删 `start:server` | 名字与 NestJS **完全对得上**（它的 `main.ts` 就是那个 `listen` 的入口）；代价是模板文件名与一路引用要一起改 |
| B 换皮 | 文件名不动（`main.ts` 仍是一次性、`server.ts` 仍是服务），只把 `start` 指到 `server.js` | 改动面小得多；但 `main.ts` 不再是 `npm start` 跑的那个文件 —— 名字会绕，且与「参考 NestJS」的初衷相悖 |

选 **A**。理由不是「像 NestJS」本身，而是：**默认入口的文件名必须就是默认跑起来的那件事**。
B 会把「`main.ts` 是一次性」这个反直觉事实永久留在脚手架里，而脚手架是使用者读的第一份代码。

⚠️ **不新增 `start:server`**（它的角色已被 `start` 吸收）—— 留一个同物的旧名字只会让人以为
服务还有另一种起法。

⚠️ **`start:prod` 加**（NestJS 用户会敲它），但它与 `start` **同物**：本脚手架的 dev 路径是
`npm run dev`（`agentia dev`），所以 `start` 已经是「跑 dist 的那条」——`start:prod` 是显式
生产名，不是另一条路。「同物两名」在这里是**刻意**的（对得上参考实现的心智），写进
`templates.ts` 的口径注里。

### 2.1 脚本表（最终形态）

```json
"dev":         "agentia dev",
"build":       "node scripts/clean.mjs && tsc -p tsconfig.json && node scripts/copy-assets.mjs",
"start":       "node dist/main.js",
"start:prod":  "node dist/main.js",
"start:batch": "node dist/batch.js",
"typecheck":   "tsc --noEmit -p tsconfig.json"
```

`npm run build && npm start` —— 这两条就是 NestJS 的 `nest build && node dist/main`。

## 3. 决策二：默认 TaskStore —— 保持 SQLite（Node 下限抬到 ≥22.5）

这是本稿**唯一一个有真实代价**的决定，摆出来：

| 方案 | 得 | 失 |
|---|---|---|
| **SQLite（采用）** | WAL + 事务、**多进程共库安全**、并发下也能续跑 —— 与 `examples/deploy/` 同一套，「可以直接上线」的成色足 | `npm start` 需要 **Node ≥22.5**；Node 18/20 上起服务抛可读报错 |
| FileTaskStore | Node ≥18 就能跑，保住框架的 `engines` 下限 | **单写者前提** ⇒ 多进程共写会交错；且与 `examples/deploy/` 分叉 |

**选 SQLite**，理由：本稿的承诺是「build 产物可以直接上线」。把一个**单写者**存储塞进「可以
上线」的默认路径，等于在默认形态里预埋一个「多副本部署会坏」的坑，而那个坑**只在生产里现形**。
Node 18/20 在 2026-10 均已 EOL（22 是 LTS），且失败形状是**可读报错**（事实 7），不是静默错。

⚠️ **下限的诚实口径**：框架**库**的 `engines: >=18` 不变、`import-floor` job 照跑（那条守的是
「包能 import」）；抬起来的是**脚手架默认路径**的最低 Node。这一句写进 `docs/deployment.md` §1，
并进 README 的 Node 提示 —— 读者不该从一次运行失败里学到这个。

## 4. 两条顺手修掉的缺陷（评审实报，非新功能）

1. **`AGENTIA_DB` 缺省是 cwd 相对**（事实 10）—— 与同脚手架的既定原则冲突（事实 12）。
   服务形态下换个 `WorkingDirectory` 启动（systemd / 容器 / `docker -w`），会**静默用另一个库**，
   `resumePending()` 什么也没找到，表面看像「任务丢了」。**改法**：缺省复用 `app.ts` 已导出的
   `PROJECT_ROOT`（`resolve(PROJECT_ROOT, 'agentia.db')`），与能力目录同一条判据、同一个常量。
2. **`PORT=` 空串静默变随机端口**（事实 11）。⚠️ **不能**改成 `|| 3000` —— 那会把 e2e 刻意
   依赖的 `PORT=0` 一起吃掉。**改法**：显式判空串走缺省，并对非整数 / 越界**响亮报错**。

## 5. 改动面（一张清单，防漏改）

| 面 | 文件 |
|---|---|
| 模板本体 | `templates/src/{main,batch}.ts`（换名）、`templates/package.json`、`templates/gitignore`（注释）、`templates/env.example`、`templates/README.md`、`templates/src/app.ts`（`.env` 口径注补 `batch.ts`） |
| CLI 源码 | `packages/cli/src/templates.ts`（访问层）、`packages/cli/src/create.ts`（写出 + 后续步骤文案） |
| 使用者文档 | `docs/usage-guide.md:104-105`、`docs/deployment.md` §1 Node 口径、`docs/guards.md:130` |
| 仓内守卫 | `scripts/e2e-cli.ts`、`packages/cli/test/templates.test.mjs`、`packages/cli/test/structure.test.mjs`（棘轮账） |
| 变更记录 | `CHANGELOG.md` 的 `[Unreleased]` 里那一节（原标题写的是 `start:server`，必须重写） |

## 6. 守卫怎么跟着走（判据：新不变量必须能被变异咬住）

- `templates.test.mjs`：原本三条钉 `serverTs` 的用例改钉 `mainTs`（服务面四根柱子 / 鉴权 /
  就绪标记），**新增**一组钉 `batchTs`（薄入口 + `result.error` 非零退出）——即把原 `mainTs`
  那两条**平移**到 `batch.ts`，不删。
- `scripts/e2e-cli.ts`：4e 改跑 `dist/batch.js`（两头跑，证 cwd 无关）；4f 改起 `dist/main.js`；
  产物表加 `dist/batch.js`；scripts 承诺表加 `start:prod` / `start:batch`；`.env` 那条成对断言
  的「不该在哪」跟着挪到两个入口（`main.ts` + `batch.ts`）。
- `structure.test.mjs`：`templates.ts` / `create.ts` 的行数基线**原位**改（⚠️ 不许插重复键 ——
  后者静默覆盖前者），并写「为什么」注。

## 7. 刻意不做

- **不给语言 / 存储加开关**（`--server` / `AGENTIA_STORE`）：脚手架生成的是**可编辑的代码**，
  「换实现」就是改那一个文件。加旋钮 = 把策略塞回框架，与「只给缝不给策略」相悖。
- **不动框架 `src/`**：本稿不新增任何框架 API。`PROJECT_ROOT` 是模板自己的导出。
- **不动 `examples/deploy/`**：它是**更完整**的生产配方（metrics / OTLP / Dockerfile / compose），
  `templates/src/main.ts` 是它的精简版，两者同一套 API —— 这一点在改后仍然成立。
