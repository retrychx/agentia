/**
 * Agentia —— 消息类型族（公共类型自有化，2026-09-17）。
 *
 * 框架公共面（ModelClient 契约 / RunSpec / SessionStore / replay 等）的消息与内容块
 * 类型，字段口径与 Anthropic Messages API 逐字对齐（snake_case），与
 * `@anthropic-ai/sdk` 的对应类型**结构兼容**（双向/单向 assignability 由
 * `tests/types/message-compat.types.ts` 钉住，SDK 因此只留在 devDependencies 做门禁）。
 *
 * 两条刻意的取舍（都有硬理由，别「顺手改进」）：
 *
 * 1. **兜底成员不带索引签名**（`UnknownContentBlockParam` / `UnknownContentBlock` 只有
 *    `type: string`）。带 `[key: string]: unknown` 的形态看起来更「前向兼容」，但 SDK 的
 *    块类型全是 **interface**（无隐式索引签名），赋给带索引签名的目标直接编译失败 ——
 *    「使用者手里的 `Anthropic.MessageParam[]` 直接喂给框架」这条承诺就会当场破产。
 *    只有 `type` 的最小面反而两个方向都通：未知块原样携带（历史回灌不丢内容），
 *    要读字段请自行收窄/断言。
 * 2. **`Role` 含 `'system'`**：SDK 0.124 的 `MessageParam.role` 是
 *    `'user' | 'assistant' | 'system'`，方向一（SDK → 自有）要求逐字对齐。
 *    引擎自身只产出 user/assistant；给 Messages API 发 system 角色会被端点拒绝，
 *    与 SDK 类型下的同款误用语义一致。
 *
 * 零依赖纯类型文件：不写运行时代码，编译后全部擦除。core 是叶子层，本文件不 import 任何模块。
 */

// —— 公共件 ——

/** 消息角色（含 'system' 的原因见文件头注释 2） */
export type Role = 'user' | 'assistant' | 'system';

/** prompt cache 断点标记（`cache_control` 字段的值） */
export interface CacheControl {
  type: 'ephemeral';
  /** 缓存 TTL；缺省 '5m'（与 SDK 的 CacheControlEphemeral 逐字对齐） */
  ttl?: '5m' | '1h';
}

// —— 请求侧（param）——

export interface TextBlockParam {
  type: 'text';
  text: string;
  cache_control?: CacheControl | null;
}

export interface ImageBlockParam {
  type: 'image';
  /**
   * 图片源：base64 / url 为已知形态；其余（如 file_id 源）走 `{ type: string }` 最小面兜底
   * （理由同文件头注释 1）。读具体字段前先按 `source.type` 收窄。
   */
  source:
    | {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
      }
    | { type: 'url'; url: string }
    | { type: string };
  cache_control?: CacheControl | null;
}

export interface ToolUseBlockParam {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControl | null;
}

export interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  /** 工具结果正文：纯文本，或 text/image 等块（未知块型走兜底成员，原样携带） */
  content?: string | Array<TextBlockParam | ImageBlockParam | UnknownContentBlockParam>;
  is_error?: boolean;
  cache_control?: CacheControl | null;
}

/**
 * 前向兼容兜底：厂商新增块类型的最小面。**刻意不带索引签名**（见文件头注释 1）——
 * 未知块在消息历史里原样携带（role 交替与 tool_use/tool_result 配对不受影响），
 * 消费方按 `type` 排除已知块后自行断言读取。
 */
export interface UnknownContentBlockParam {
  type: string;
}

/** 请求侧内容块联合：已知块 + 兜底成员（厂商新块型原样携带） */
export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | UnknownContentBlockParam;

export interface MessageParam {
  role: Role;
  content: string | ContentBlockParam[];
}

/** 工具的 input_schema 形状（与 SDK 的 Tool.InputSchema 逐字对齐） */
export interface ToolInputSchema {
  type: 'object';
  properties?: unknown;
  required?: string[] | null;
  [key: string]: unknown;
}

/**
 * 发给模型的工具定义（**避让 @Tool 装饰器**，故名 ToolParam）。
 * 引擎从 AgentTool 推导（`engine/loop.ts` 的 toApiTool）；自定义 ModelClient 只读它。
 * 与块类型同理**不带索引签名**（文件头注释 1）：SDK 的 `Tool` 是 interface，
 * 带索引签名会让「SDK 的工具定义数组直接喂给自定义 client」编译失败。
 * 厂商新增的工具字段（defer_loading 等）读之前自行断言。
 */
export interface ToolParam {
  name: string;
  description?: string;
  input_schema: ToolInputSchema;
  strict?: boolean;
  cache_control?: CacheControl | null;
}

// —— 响应侧 ——

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/** 响应侧兜底块（语义同 UnknownContentBlockParam，见文件头注释 1） */
export interface UnknownContentBlock {
  type: string;
}

/** 响应侧内容块联合：text / tool_use / thinking + 兜底成员 */
export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | UnknownContentBlock;

/**
 * 模型 stop_reason。已知取值与 SDK 逐字对齐；`| (string & {})` 收留端点未来的新值
 * （引擎对未识别的 stop_reason 有 `unknown_stop_reason` 收尾分支，见 engine/loop.ts）。
 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded'
  | (string & {});

/** 模型回报的 token 计量（**避让 trace 的 `Usage`**（camelCase 聚合），故名 MessageUsage） */
export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** 一次模型往返的最终响应（`ModelClient.messages.stream().finalMessage()` 的产物） */
export interface Message {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: MessageUsage;
}
