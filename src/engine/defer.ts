/**
 * 延后请求（durable timer）的**纯判定与收集**：工具说「现在还不是时候，T 之后再问我」。
 *
 * 为什么单独成件：这是挂起的第二个**原因**（`core/run.ts` 的 `SuspendedReason` —— timer 侧）。
 * 它与审批（approval）的关键差别决定了这个文件里的每一条规则：
 *
 * | | 审批 | 延后 |
 * |---|---|---|
 * | 谁提 | **宿主**在执行前给决定（引擎只查 `args.approvals`） | **工具**在跑的时候提 |
 * | 判据 | 「决定在不在」（没有就不执行） | 「时刻到了没」（没到就挂起） |
 * | 非法值 | 不适用（决定是布尔） | **有**：T 在过去 / 非有限数 ⇒ 必须响亮拒绝 |
 *
 * 后一行是本文件存在的理由：延后是**工具运行时**提出的，取值就成了一条外部契约。
 * 让「T ≤ 现在」成立的话，到期扫描读到它会立刻唤醒、续跑、工具再请求同一个过去时刻 ——
 * **一条自己打转的 run**（每次都不花钱，但 store / trace / 判据全在空转，且永不收尾）。
 * 所以 `resolveWakeAt` 把「必须在将来」做成**当场抛错**：那次工具调用以 is_error 的
 * tool_result 回给模型（既有路径），run 照常往前走 —— 不静默、不挂起成僵尸。
 *
 * 第二件审批不需要解决的事：**一个回合一挂起**（协议要求每个 tool_use 都有配对的
 * tool_result），所以同回合的多个延后请求只能合并成一个时刻 —— 取**最早**的那个
 * （「早醒」是可补救的：醒来看还没到就再请求一次；「晚醒」则白等）。
 *
 * 纯的边界：只吃 `(at, now)`，只吐结论；不碰 recorder、不碰 ctx、不改任何 rec。
 * 时刻口径是**绝对毫秒时间戳**（epoch ms）—— 它要落库、要跨进程比较，相对毫秒不行。
 */

/**
 * 校验并归一化一次延后请求的时刻（epoch ms）。
 *
 * - `Date` 取 `getTime()`，数字原样用；
 * - 非有限数（NaN / Infinity / 非数字）⇒ TypeError；
 * - **不晚于现在**（`at <= now`）⇒ TypeError。
 *
 * 边界是**严格大于**：恰好等于「现在」不算将来（同一毫秒里到期扫描会立刻捞起它）。
 */
export function resolveWakeAt(input: number | Date, now: number): number {
  const at = input instanceof Date ? input.getTime() : input;
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new TypeError(
      `deferUntil 需要一个将来时刻（epoch 毫秒或 Date），收到 ${String(input)} —— ` +
        '非有限值会在落库/比较时静默失效',
    );
  }
  if (at <= now) {
    throw new TypeError(
      `deferUntil 的时刻必须在将来（收到 ${at}，现在是 ${now}）—— ` +
        '「现在就能续」表达不了「T 之后再问我」，而且到期扫描会立刻唤醒它、原样再请求一次（自己打转的 run）',
    );
  }
  return at;
}

/** 一个回合收到的全部延后请求（每个 `executeTurnTools` 一次，随回合消亡） */
export interface DeferRequest {
  /** 记一次请求。同一个 tool_use_id 重复请求取**最早**的那个（早醒可补救，晚醒白等） */
  request(toolUseId: string, at: number | Date): void;
  /** 本回合的目标时刻：所有请求里**最早**的那个；一个请求都没有 ⇒ undefined */
  earliest(): number | undefined;
  /** 请求过延后的 tool_use_id（按请求到达顺序；并行工具下即完成顺序） */
  ids(): string[];
}

/**
 * 建一个回合级的延后请求收集器。`clock` 只为单测注入（默认 `Date.now`）——
 * 「什么是过去」由它决定，测试不该依赖墙钟。
 */
export function createDeferRequest(clock: () => number = Date.now): DeferRequest {
  const asked = new Map<string, number>();
  return {
    request(toolUseId, at) {
      const wakeAt = resolveWakeAt(at, clock());
      const prev = asked.get(toolUseId);
      if (prev === undefined || wakeAt < prev) asked.set(toolUseId, wakeAt);
    },
    earliest() {
      let min: number | undefined;
      for (const at of asked.values()) if (min === undefined || at < min) min = at;
      return min;
    },
    ids() {
      return [...asked.keys()];
    },
  };
}
