export const AGENTIA_VERSION = '0.2.1';

// core：数据模型
export type {
  Trace,
  Span,
  SpanEvent,
  SpanError,
  SpanId,
  SpanKind,
  SpanStatus,
  TraceId,
  TraceSink,
  UnitType,
  Usage,
} from './core/trace.js';
export type {
  AgentTool,
  JsonSchema,
  ModelClient,
  RecorderBackend,
  SchemaInput,
  SchemaType,
  ToolRunContext,
  TypedSchema,
} from './core/tool.js';
export { validateJsonSchema } from './core/schema.js';
export { combineSignals } from './core/abort.js';

// engine：运行时内核
export { runAgent, resolveDefaultModel } from './engine/loop.js';
export { TraceRecorder } from './engine/tracer.js';
export { classifyError, isAbortError } from './engine/errors.js';
export { isSuccessStopReason } from './engine/types.js';
export type {
  AgentRunResult,
  AgentStopReason,
  ContextPolicy,
  RunAgentOptions,
  SystemParam,
  SystemTextBlock,
} from './engine/types.js';

// engine：长上下文策略
export {
  defaultEstimateTokens,
  estimateMessages,
  renderMessages,
  trimToolPairs,
  compactMessages,
} from './engine/trimming.js';
export type { CompactOptions, TrimOptions } from './engine/trimming.js';
export { createBudgetPolicy } from './engine/policy.js';
export type { BudgetPolicyOptions } from './engine/policy.js';
export { DEFAULT_RETRY } from './engine/retry.js';
export type { RetryOptions } from './engine/retry.js';

// run：run 生命周期
export { Run, executeRun } from './runtime/run.js';
export { RunContext, withRunContext } from './runtime/context.js';
export type { Blackboard, BlackboardKey, BlackboardSeed, BlackboardValue } from './runtime/context.js';
export { SystemPrompt } from './runtime/systemPrompt.js';
export type { SystemSection } from './runtime/systemPrompt.js';
export type { ExecuteRunOptions } from './runtime/run.js';
export type { RunMeta, RunStatus } from './runtime/types.js';

// container：显式 DI
export { Container } from './container/container.js';
export type {
  Provider,
  ClassProvider,
  ValueProvider,
  FactoryProvider,
  Token,
} from './container/container.js';

// toolkit：声明式单元 + 应用装配
export { asset } from './toolkit/asset.js';
export { discoverProviders } from './toolkit/discover.js';
export { applyMiddleware } from './toolkit/middleware.js';
export type { UnitCall, UnitMiddleware, UnitNext } from './toolkit/middleware.js';
export { Tool, collectTools } from './toolkit/tool.js';
export type { ToolSpec } from './toolkit/tool.js';
export { SubAgent, collectSubAgents, subagentToTool } from './toolkit/subagent.js';
export type { SubAgentSpec, SubAgentUnit } from './toolkit/subagent.js';
export { Skill, collectSkills, skillToTool } from './toolkit/skill.js';
export type {
  SkillContext,
  SkillLlmOptions,
  SkillLlmResult,
  SkillSpec,
  SkillUnit,
} from './toolkit/skill.js';
export { Prompt, collectPrompts } from './toolkit/prompt.js';
export type { PromptSpec } from './toolkit/prompt.js';
export { createApp, AgentApp, registerDefaultTraceSink } from './toolkit/module.js';
export type { AppOptions, RunAppOptions, AgentRunOutput } from './toolkit/module.js';
export { defineModule } from './toolkit/module.js';
export type { AgentModule } from './toolkit/module.js';
export { fromZod } from './toolkit/zod.js';

// run：触发传输 + run 存储
export { normalizeMessages } from './runtime/spec.js';
export type { RunInput, RunSpec, RunInvocationOptions } from './runtime/spec.js';
export { InMemoryTaskStore } from './store/store.js';
export type { TaskRecord, TaskStore } from './store/store.js';
export { FileTaskStore } from './store/fsStore.js';
export { AsyncRunner } from './transport/async.js';
export type {
  AppCallable,
  AsyncRunnerOptions,
  ResumePendingOptions,
} from './transport/async.js';
export { Scheduler } from './transport/scheduler.js';
export type { ScheduleEveryOptions, ScheduleHandle } from './transport/scheduler.js';
export { runSync, createSyncHandler } from './transport/transport.js';

// run：宿主与导出（R3/R4）
export { createHttpHandler, HttpException } from './transport/http.js';
export type {
  HttpHandlerOptions,
  HttpHandler,
  HealthResponse,
  RunHttpResponse,
  TaskSubmitBody,
} from './transport/http.js';
export { SqliteTaskStore } from './store/sqliteStore.js';
export { createOtlpExporter } from './integrations/otlp.js';
export { createOpenAIClient } from './integrations/openai.js';
export { InMemoryMemoryStore } from './runtime/memory.js';
export type { MemoryStore } from './runtime/memory.js';
export { RedisTaskStore } from './store/redisStore.js';
export type { RedisLike, RedisSetOptions, RedisTaskStoreOptions } from './store/redisStore.js';
export type { MaybePromise } from './store/store.js';
export { traceToMessages } from './engine/replay.js';
export type { ReplayOptions } from './engine/replay.js';

