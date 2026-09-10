export const AGENTIA_VERSION = '0.1.0';

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
  UnitType,
  Usage,
} from './core/trace.js';
export type { AgentTool, JsonSchema, ModelClient, RecorderBackend, ToolRunContext } from './core/tool.js';
export { validateJsonSchema } from './core/schema.js';

// engine：运行时内核
export { runAgent, resolveDefaultModel } from './engine/loop.js';
export { TraceRecorder } from './engine/tracer.js';
export { classifyError } from './engine/errors.js';
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
} from './engine/context.js';
export type { CompactOptions, TrimOptions } from './engine/context.js';
export { createBudgetPolicy } from './engine/policy.js';
export type { BudgetPolicyOptions } from './engine/policy.js';

// run：run 生命周期
export { Run, executeRun } from './run/run.js';
export { RunContext, withRunContext } from './run/context.js';
export { SystemPrompt } from './run/systemPrompt.js';
export type { SystemSection } from './run/systemPrompt.js';
export type { ExecuteRunOptions } from './run/run.js';
export type { RunMeta, RunStatus } from './run/types.js';

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
export { createApp, AgentApp } from './toolkit/module.js';
export type { AppOptions, RunAppOptions, AgentRunOutput } from './toolkit/module.js';
export { defineModule } from './toolkit/module.js';
export type { AgentModule } from './toolkit/module.js';
export { fromZod } from './toolkit/zod.js';

// run：触发传输 + run 存储
export { normalizeMessages } from './run/spec.js';
export type { RunInput, RunSpec, RunInvocationOptions } from './run/spec.js';
export { InMemoryTaskStore } from './run/store.js';
export type { TaskRecord, TaskStore } from './run/store.js';
export { FileTaskStore } from './run/fsStore.js';
export { AsyncRunner } from './run/async.js';
export type { AsyncRunnerOptions, AppCallable } from './run/async.js';
export { Scheduler } from './run/scheduler.js';
export type { ScheduleEveryOptions, ScheduleHandle } from './run/scheduler.js';
export { runSync, createSyncHandler } from './run/transport.js';

// run：宿主与导出（R3/R4）
export { createHttpHandler } from './run/http.js';
export { SqliteTaskStore } from './run/sqliteStore.js';
export { createOtlpExporter } from './run/otlp.js';
export { createOpenAIClient } from './run/openai.js';
export { InMemoryMemoryStore } from './run/memory.js';
export type { MemoryStore } from './run/memory.js';

