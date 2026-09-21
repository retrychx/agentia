/**
 * Agentia —— **limits 语义的单一真源**。
 *
 * 为什么要有这个文件（`docs/guards.md` §2 的第一条待守形状）：
 *
 * 本仓把「非正数 = 机制关掉」当成一条统一口径，但它被**每个旋钮各自解释**了一遍 ——
 * 同一个 `0` 在这里是「不限」、在那里是「一次都不做」、在第三个地方是「配置错误」。
 * 历史事故就出在这条缝上：`handler.drain({ timeoutMs: 1 })` 跨过 deadline 后**永不返回**
 * （调用方按「1 毫秒 = 马上就超时」写，代码里却是另一套读法），而当时没有任何一处
 * 集中写着「这个旋钮的 0 是什么意思」。改到相关代码时只能靠人去猜 —— 于是又猜错。
 *
 * 本文件把「每个旋钮的 0 是什么」变成**可执行的数据**，`tests/limits.test.ts` 再拿这份
 * 表去**驱动真实站点**逐条对账：表里声明 `0 = 不限`，用例就去调那个真 API 并断言它真的
 * 不限。所以：
 *
 * - 表与实现漂了 ⇒ 集中用例红（不是文档过期，是构建失败）；
 * - 新增一个旋钮却忘了归类 ⇒ 用例里 `Record<LimitKnob, …>` 少一项，`typecheck:tests` 红。
 *
 * ⚠️ 本模块**不是公共 API**（不进 `src/index.ts`）：它是内部口径的真源，不是给使用者的旋钮。
 * 面向使用者的口径在 `docs/usage-guide.md` 的「边界」一节。
 *
 * ⚠️ 表里的 `zeroClause` 是**报错文案的一部分**：四处构造期校验（`runTimeoutMs` /
 * `approvalTimeoutMs` / `traceLimits.maxEvents` / `maxRetries`）把它插进错误消息里
 * （`…（0 = 不重试），收到 -1 —— …`）。所以「文案里怎么解释 0」与「代码里怎么实现 0」
 * 是同一个值，改一处等于同时改另一处 —— 这正是先前缺的那条单源。
 */

/**
 * 一个旋钮在取 `0`（或「非正数」）时的**含义分类**。四选一，没有第五种：
 *
 * - `unlimited` —— **0 = 不限**。时间是「等多久 / 最多多久」的上限，0 表示去掉这个上限。
 *   使用者的直觉通常是这个；本仓只有一部分旋钮真的是这个意思，这正是要对账的原因。
 * - `disabled` —— **0 = 机制关掉 / 一次都不做**。数量是「做几次」，0 次就是不做。
 *   ⚠️ 与 `unlimited` 是**相反的**读法：`maxRetries: 0` 是「不重试」而不是「无限重试」；
 *   `maxEvents: 0` 是「一条都不记」而不是「不限条数」。
 * - `immediate` —— **0 = 立即执行，不等**。等待预算为 0 ⇒ 这次等待压根不存在。
 *   与 `disabled` 的区别：机制没被关掉，只是这一次立刻发生（`metricsSink` 的
 *   `intervalMs: 0` = 立即导出；`interruptibleSleep(0)` = 不睡）。
 * - `invalid` —— **0 = 非法配置，构造期响亮失败**。0 在这里没有任何合理读法
 *   （`concurrency: 0` 没有 worker；`Scheduler.every(0)` 是空转），静默接受只会
 *   把它变成另一件事（Node 会把 `setInterval(0)` 钳到 1ms ⇒ 每毫秒一轮的忙轮询）。
 */
export type ZeroMeaning = 'unlimited' | 'disabled' | 'immediate' | 'invalid';

/** 坏值（非有限 / 负数 / 小数 / 类型不对）的处理方式 */
export type BadValuePolicy =
  /** 构造期抛错 —— 使用者以为自己设了上限，静默接受就会变成别的行为 */
  | 'throws'
  /** 一律视为「不限」（旧行为），不报错 */
  | 'coerced-to-unlimited'
  /** 无校验（该旋钮只做算术，坏值无处可藏） */
  | 'none';

export interface LimitSemantic {
  /** 稳定标识（用例按它建表；改名 = 用例红，故意的） */
  readonly knob: string;
  /** 实现位置（文件名:符号），改代码时的入口 */
  readonly where: string;
  readonly unit: 'ms' | 'count' | 'chars' | 'n/a';
  readonly zero: ZeroMeaning;
  /**
   * 报错文案里那句「0 = 什么」（无报错的旋钮也写上 —— 文档与用例都读它）。
   * 有构造期校验的旋钮由实现代码直接插进错误消息。
   */
  readonly zeroClause: string;
  readonly badValue: BadValuePolicy;
  /** 为什么是这个读法（一句话；踩过坑的把坑写上） */
  readonly note: string;
}

/**
 * 全部 limits 旋钮的 0 语义。**分组按读法**，好让人一眼看出哪几个是相反的。
 */
export const LIMIT_SEMANTICS = [
  // ── 0 = 不限（时间的上限被去掉）──────────────────────────────────────────
  {
    knob: 'AsyncRunner.runTimeoutMs',
    where: 'transport/async.ts',
    unit: 'ms',
    zero: 'unlimited',
    zeroClause: '0 = 不限',
    badValue: 'throws',
    note: 'NaN/Infinity 会被 setTimeout 钳到 1ms ⇒ 每个任务立即「超时」失败，且 NaN 会绕过 `< 0` 静默通过；所以要「不限」必须显式传 0。',
  },
  {
    knob: 'AsyncRunner.approvalTimeoutMs',
    where: 'transport/async.ts',
    unit: 'ms',
    zero: 'unlimited',
    zeroClause: '0 = 不限',
    badValue: 'throws',
    note: '同 runTimeoutMs：非有限数会让「已挂起多久」的比较静默失效或立即超时。',
  },
  {
    knob: 'AsyncRunner.drain.timeoutMs',
    where: 'transport/drain-gate.ts',
    unit: 'ms',
    zero: 'unlimited',
    zeroClause: '非正 = 一直等',
    badValue: 'none',
    note: '**历史事故现场**：`http.ts` 的优雅停机把剩余预算算成 `timeoutMs - elapsed` 再交给它，deadline 已过时算出 1 或 0 ⇒ 旧读法（`0` = 已到点）让它跨过 deadline 后**永不返回**。现在 `http.ts` 自己先判「已到点就认账」，不把 0 交给下游去猜。',
  },
  {
    knob: 'mapWithConcurrency.limit',
    where: 'engine/concurrency.ts',
    unit: 'count',
    zero: 'unlimited',
    zeroClause: '非正 = 不限',
    badValue: 'coerced-to-unlimited',
    note: '⚠️ 与 `maxToolConcurrency` 成对：这是**唯一**「数量」旋钮取 0 却读作「不限」的。另有一条反向的坑：`(0,1)` 区间的小数若交给 `Math.floor` 会压成 0 worker ⇒ 工具被静默丢弃，所以正数一律至少 1 个 worker（`maxToolConcurrency: cpus().length / 8` 在多核 < 8 的机器上正落在那个区间）。',
  },

  // ── 0 = 机制关掉 / 一次都不做（数量旋钮；与上面相反）─────────────────────
  {
    knob: 'traceLimits.maxEvents',
    where: 'engine/tracer.ts',
    unit: 'count',
    zero: 'disabled',
    zeroClause: '0 = 一条都不记',
    badValue: 'throws',
    note: '⚠️ 与 `maxEventChars`（管「多长」）正交，一个管「多少」。0 是**有意义的值**（一条都不记，但计数照记）—— 不是「不限条数」。',
  },
  {
    knob: 'maxRetries',
    where: 'integrations/adapter-options.ts',
    unit: 'count',
    zero: 'disabled',
    zeroClause: '0 = 不重试',
    badValue: 'throws',
    note: '坏值必须响亮失败：判定是 `attempt >= maxRetries` ⇒ `NaN` 比较恒假、`Infinity` 永远达不到，两者都是**无限重试**（429 场景下每一次都是真金白银）；`-1` 静默变成「不重试」；`1.5` 实际只允许 1 次。',
  },
  {
    knob: 'maxEventChars',
    where: 'engine/tool-events.ts',
    unit: 'chars',
    zero: 'disabled',
    zeroClause: '0 = 截到零长度；false = 不截断',
    badValue: 'none',
    note: '两个「关掉」的写法语义不同：`false` 才是「不截断」（调试期看全文），`0` 是把正文截成空串。⚠️ 靠 `!= null` 判定透传（真值判定会吃掉 `false`）。',
  },
  {
    knob: 'runAgent.maxIterations',
    where: 'engine/loop.ts',
    unit: 'count',
    zero: 'disabled',
    zeroClause: '0 = 一次都不跑',
    badValue: 'none',
    note: '循环写成 `for (iteration = 0; iteration < maxIterations; ...)` ⇒ 0 时循环体一次不执行，直接以「达到循环上限」收尾（**算失败**）。是「已到点」而非「不限」，与 `mapToolConcurrency` 的读法**相反**。',
  },
  {
    knob: 'withTimeout.ms',
    where: 'core/timeout.ts',
    unit: 'ms',
    zero: 'disabled',
    zeroClause: '非正 = 不设超时（原样透传）',
    badValue: 'none',
    note: '`toolTimeoutMs` 的底座。⚠️ 漏透传这个值不是「少一层保险」而是**反的**：`withTimeout(p, 0)` 直接返回原 promise = 永不超时，同时 MCP 桥找不到引擎预算又起自己的 60s 兜底 ⇒ 双计时器、双账本（`toolkit/subagent.ts` / `skill.ts` 的透传注释指的就是这条）。',
  },

  // ── 0 = 立即执行（等待预算为 0 ⇒ 这次等待不存在）─────────────────────────
  {
    knob: 'interruptibleSleep.ms',
    where: 'core/timeout.ts',
    unit: 'ms',
    zero: 'immediate',
    zeroClause: '非正 = 不睡',
    badValue: 'none',
    note: '⚠️ 这一判**先于** aborted 检查 —— 别把它「修」成「已中止就该 reject」。2026-09-19 外部复核把它当一致性缺口改反过一次，被 `tests/core/timeout.test.ts` + `tests/core/sse-text-stats.test.ts` 拦住。',
  },
  {
    knob: 'metricsSink.intervalMs',
    where: 'integrations/metrics.ts',
    unit: 'ms',
    zero: 'immediate',
    zeroClause: '0 = 立即导出',
    badValue: 'none',
    note: '⚠️ **同名反义**：`Scheduler.every` 的 `intervalMs: 0` 是**配置错误**（抛错），这里却是「关掉定时器、每次累加后立即导出」。两个同名旋钮两种读法 —— 改任何一个之前先看这张表。',
  },

  // ── 0 = 非法配置（响亮失败）─────────────────────────────────────────────
  {
    knob: 'AsyncRunner.concurrency',
    where: 'transport/async.ts',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '必须为正数（0 = 没有 worker）',
    badValue: 'throws',
    note: '0 个 worker 的池子会让每个任务永远排在队列里（既不跑也不失败）。',
  },
  {
    knob: 'Scheduler.every.intervalMs',
    where: 'transport/scheduler.ts',
    unit: 'ms',
    zero: 'invalid',
    zeroClause: '必须为正有限数（0 会空转）',
    badValue: 'throws',
    note: '`setInterval(0)` 退化成「尽快重复」的空转循环（Node 钳到 1ms，仍是每毫秒一轮忙轮询）；超过 2^31-1ms 会被**静默**钳到 1ms，同款失败。',
  },
  {
    knob: 'createAnthropicClient.timeout',
    where: 'integrations/anthropic.ts',
    unit: 'ms',
    zero: 'invalid',
    zeroClause: '不设 = 不限；0 = 非法',
    badValue: 'throws',
    note: '「不限」的表达方式是**不传**，不是传 0 —— 与 `runTimeoutMs` 的读法**相反**（那个要求显式传 0）。',
  },
  {
    knob: 'metricsSink.windowSize',
    where: 'integrations/metrics.ts',
    unit: 'count',
    zero: 'invalid',
    zeroClause: '必须为正数（0 = 窗口里什么都没有）',
    badValue: 'throws',
    note: '同款的还有 `maxCapabilities` / `maxModels` / `maxScores` —— 都是「必须为正数」。',
  },
] as const satisfies readonly LimitSemantic[];

/** 表里全部旋钮的标识（用例按它建穷尽表：少一项 `typecheck:tests` 就红） */
export type LimitKnob = (typeof LIMIT_SEMANTICS)[number]['knob'];

/** 按旋钮取那行（拼错旋钮名 = 编译期报错，不是运行期 undefined） */
export function limitSemanticOf(knob: LimitKnob): LimitSemantic {
  const found = LIMIT_SEMANTICS.find((s) => s.knob === knob);
  // 表是 `as const` 的封闭集合，knob 类型来自它 ⇒ 这里不可能落到 undefined；
  // 保留分支是为了让「表被改空」时给出可读的失败而不是 TypeError。
  if (!found) throw new Error(`limits 表里没有旋钮 ${knob}（表被改空了？）`);
  return found;
}

/**
 * 报错文案里那句「（0 = …）」。**构造期校验直接插它**，所以文案与表不可能各说各话。
 */
export function zeroClauseOf(knob: LimitKnob): string {
  return limitSemanticOf(knob).zeroClause;
}
