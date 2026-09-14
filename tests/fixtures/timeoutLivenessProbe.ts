/**
 * 子进程探针：**空事件循环**下，「被 await 的超时」到底会不会触发。
 *
 * 为什么非要开子进程：本探针要的正是「进程里除了这个截止计时器没有别的把手」这个条件。
 * 在 `node --test` 的同进程里跑不出问题 —— 测试跑器自己持有把手，等于把 bug 藏起来
 * （这正是 2026-09-14 那次 CI 红法：`failureType: cancelledByParent`，
 * `error: 'Promise resolution is still pending but the event loop has already resolved'`）。
 *
 * 输出一行 `LIVENESS ok: <case> → …` 即通过；若进程在计时器触发前就退出，
 * 父测试看不到这一行 —— 这就是判据（见 `tests/timeoutLiveness.test.ts`）。
 */
import { AsyncRunner, runAgent } from '../../src/index.js';
import type { AgentTool } from '../../src/index.js';
import { withDeadline } from '../../src/integrations/mcp.js';
import { endTurnMsg, mockClient, toolUseMsg } from '../helpers.js';

const which = process.argv[2] ?? '';

/** 永不 settle：模拟「工具挂死 / 调用无响应」 */
const never = <T>(): Promise<T> => new Promise<T>(() => {});

const SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

if (which === 'engine') {
  // 工具级超时（engine/withTimeout）：挂死的工具 + 30ms 预算 ⇒ 必须**回到** `end_turn`
  // 并记一条 errorKind=timeout，而不是让整段 await 消失。
  const { client } = mockClient([toolUseMsg('hang', {}, 'tu1'), endTurnMsg('done')]);
  const tool: AgentTool = {
    name: 'hang',
    description: '永不返回',
    inputSchema: SCHEMA as unknown as AgentTool['inputSchema'],
    run: () => never<string>(),
  };
  const result = await runAgent({
    messages: [{ role: 'user', content: 'go' }],
    client: client as never,
    toolTimeoutMs: 30,
    tools: [tool],
  });
  const body = result.trace.spans.flatMap((s) => s.events).find((e) => e.name === 'tool.output')
    ?.body as { errorKind?: string } | undefined;
  console.log(`LIVENESS ok: engine → stopReason=${result.stopReason} errorKind=${body?.errorKind}`);
} else if (which === 'mcp') {
  // MCP 调用超时（integrations/mcp.ts withDeadline）：必须抛出「调用超时」。
  try {
    await withDeadline(never<string>(), 30, 'probe');
    console.log('LIVENESS fail: mcp → 没超时（不该发生）');
  } catch (e) {
    console.log(`LIVENESS ok: mcp → ${(e as Error).message}`);
  }
} else if (which === 'drain') {
  // 优雅停机（transport/async.ts drain）：有在飞任务时，等不到就该在预算后**返回 false**。
  const runner = new AsyncRunner({ name: 'probe', run: () => never<never>() } as never, {
    concurrency: 1,
  });
  runner.submit([{ role: 'user', content: 'x' }]);
  const drained = await runner.drain({ timeoutMs: 30 });
  console.log(`LIVENESS ok: drain → ${drained}（false = 预算耗尽仍未停完）`);
} else {
  console.log(`LIVENESS fail: 未知用例 ${JSON.stringify(which)}`);
  process.exitCode = 2;
}
