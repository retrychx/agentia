/*
 * 公共消息类型 ↔ `@anthropic-ai/sdk` 结构兼容门禁（**只做类型检查，不运行** ——
 * 文件名不是 *.test.ts，node:test 不会收；由 `npm run typecheck:types` 校验，针对 dist）。
 *
 * SDK 已退出运行时依赖（dependencies 为空），留在 devDependencies 的**唯一**理由就是
 * 这份门禁：两个方向的 assignability 一旦有任一边漂移（SDK 升级改字段 / 我们改类型族），
 * 编译立刻失败。
 *
 * 方向一（SDK → 自有）：使用者手里的 `Anthropic.MessageParam[]` / `Anthropic.Message`
 * 必须能**整体**直接赋给自有类型 —— 包括 SDK 联合里我们不认识的块型（走兜底成员）。
 * 方向二（自有 → SDK）：自有的**具体**块（text / tool_use / tool_result / cache_control）
 * 必须能赋回 SDK 对应类型；兜底成员除外（它本就代表「SDK 还不认识的块」）。
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  CacheControl,
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageParam,
  TextBlockParam,
  ToolParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '../../dist/index.js';

/* ================= 方向一：SDK → 自有（整体赋值） ================= */

declare const sdkMessages: Anthropic.MessageParam[];
const msgsIn: MessageParam[] = sdkMessages;

declare const sdkMessage: Anthropic.Message;
const msgIn: Message = sdkMessage;

declare const sdkText: Anthropic.TextBlockParam;
const textIn: TextBlockParam = sdkText;

declare const sdkToolUse: Anthropic.ToolUseBlockParam;
const toolUseIn: ToolUseBlockParam = sdkToolUse;

declare const sdkToolResult: Anthropic.ToolResultBlockParam;
const toolResultIn: ToolResultBlockParam = sdkToolResult;

declare const sdkTool: Anthropic.Tool;
const toolIn: ToolParam = sdkTool;

declare const sdkContent: Anthropic.ContentBlock[];
const contentIn: ContentBlock[] = sdkContent;

declare const sdkCache: Anthropic.CacheControlEphemeral;
const cacheIn: CacheControl = sdkCache;

/* ================= 方向二：自有具体块 → SDK ================= */

declare const ownText: TextBlockParam;
const textOut: Anthropic.TextBlockParam = ownText;

declare const ownToolUse: ToolUseBlockParam;
const toolUseOut: Anthropic.ToolUseBlockParam = ownToolUse;

// ToolResultBlockParam 的 content 元素联合含兜底成员（SDK 联合里没有），整体赋值必然不过 ——
// 方向二只承诺「具体形态」，用具体值断言：
const toolResultOut: Anthropic.ToolResultBlockParam = {
  type: 'tool_result',
  tool_use_id: 'tu_1',
  content: 'ok',
  is_error: false,
};

declare const ownCache: CacheControl;
const cacheOut: Anthropic.CacheControlEphemeral = ownCache;

// 自有 Message → SDK Message 不承诺（SDK 侧有 container / stop_details 等额外必填字段），
// 没人需要这个方向：Message 是**产出**侧类型，只会从 client 流向调用方。

/* ================= @ts-expect-error：不该过的（钉住边界） ================= */

// @ts-expect-error 兜底形态的块（未知块型）不能赋给 SDK 的精确块类型
const badText: Anthropic.TextBlockParam = { type: 'future_block' };

const future = { type: 'brand_new_block' } as const;
const futureOk: ContentBlockParam = future; // 自有联合收（前向兼容兜底成员）
// @ts-expect-error 但不能回赋给 SDK 的精确联合
const futureNo: Anthropic.ContentBlockParam = future;

declare const ownParams: MessageParam[];
// @ts-expect-error 自有联合含兜底成员，整体不能回赋 SDK（方向二只对具体块承诺）
const paramsOut: Anthropic.MessageParam[] = ownParams;

// @ts-expect-error role 之外的字面量两边都不收
const badRole: MessageParam = { role: 'narrator', content: 'x' };

// @ts-expect-error usage 的 input_tokens 是 number，不是 string
const badUsage: Message['usage'] = { input_tokens: '10', output_tokens: 5 };

/* 让上面的断言变量都被引用（与 dx.types.ts 同款的 noUnusedVariables 兜底） */
void [
  msgsIn,
  msgIn,
  textIn,
  toolUseIn,
  toolResultIn,
  toolIn,
  contentIn,
  cacheIn,
  textOut,
  toolUseOut,
  toolResultOut,
  cacheOut,
  badText,
  futureOk,
  futureNo,
  paramsOut,
  badRole,
  badUsage,
];
