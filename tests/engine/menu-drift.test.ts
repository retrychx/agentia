import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeRun, runAgent } from '../../src/index.js';
import type { AgentTool, Span, Trace } from '../../src/index.js';
import { detectMenuDrift, menuSignature } from '../../src/engine/menu-drift.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

/**
 * 菜单漂移（R8 候选 3 / durable 调研 `docs/plans/2026-09-27-durable-execution-research.md`
 * §4.1 实测 + §6 候选 3；取舍见 spec §10）。
 *
 * 钉两件事：
 * - `menuSignature` / `detectMenuDrift` 的**判定口径**（纯件，单独可测）；
 * - **续跑**时未决 tool_use 的工具没了 ⇒ 三处可见（事件 / 属性 / console.warn），且
 *   run **不判失败**（本轮的取舍）；而**回合内**的未知工具**不**走这条（那是模型的幻觉，
 *   走既有 `unknown_tool` 路径 —— 两类动作不同，两条阴性对照各钉一边）。
 */

const OBJ = { type: 'object', properties: {}, additionalProperties: false } as const;

function tool(name: string, extra: Partial<AgentTool> = {}): AgentTool {
  return { name, description: name, inputSchema: OBJ, run: () => `${name}-ok`, ...extra };
}

const rootOf = (trace: Trace): Span => trace.spans.find((s) => s.spanId === trace.rootSpanId)!;
const eventsOf = (spans: readonly Span[], name: string) =>
  spans.flatMap((s) => s.events.filter((e) => e.name === name));

/** 第一段：跑一条 approval 工具、不给决定 ⇒ 挂起（拿到可续跑的消息历史） */
async function suspendMessages(): Promise<unknown[]> {
  const danger = tool('danger', { approval: 'required' });
  const { result } = await executeRun({
    messages: [{ role: 'user', content: 'go' }],
    client: mockClient([toolUseMsg('danger', {}, 'tu-danger')]).client,
    tools: [danger],
  });
  assert.equal(result.stopReason, 'suspended', '前提：这一段必须挂在审批上');
  return result.suspendedMessages!;
}

/** console.warn 捕获（本仓既有写法：手动换 + finally 还原） */
function captureWarn<T>(fn: () => Promise<T>): Promise<{ warnings: string[]; value: T }> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  return fn()
    .then((value) => ({ warnings, value }))
    .finally(() => {
      console.warn = orig;
    });
}

describe('menu-drift 纯件：签名与漂移判定', () => {
  it('menuSignature：与菜单顺序无关，名字清单是排序后的', () => {
    const a = menuSignature([tool('beta'), tool('alpha')]);
    const b = menuSignature([tool('alpha'), tool('beta')]);
    assert.equal(a.hash, b.hash, '同一个菜单换数组顺序不算漂移');
    assert.equal(a.names, 'alpha,beta');
  });

  it('menuSignature：**schema 变了 ⇒ hash 变**（「工具还在、签名变了」的判据）', () => {
    const before = menuSignature([tool('pick', { inputSchema: OBJ })]);
    const after = menuSignature([
      tool('pick', {
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      }),
    ]);
    assert.notEqual(before.hash, after.hash, '签名（schema）变了必须能被比出来');
    assert.equal(before.names, after.names, '名字没变 —— 只有 hash 能抓到这一种漂移');
  });

  it('menuSignature：schema 的**键序**不算变化（规范序列化）；`description` 也不参与签名', () => {
    const p1 = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } };
    const p2 = { type: 'object', properties: { b: { type: 'number' }, a: { type: 'string' } } };
    assert.equal(
      menuSignature([tool('t', { inputSchema: p1 })]).hash,
      menuSignature([tool('t', { inputSchema: p2 })]).hash,
      '同一份 schema 的键序不同 = 同一份菜单',
    );
    assert.notEqual(
      menuSignature([tool('t', { inputSchema: p1 })]).hash,
      menuSignature([tool('t', { inputSchema: { type: 'object', properties: {} } })]).hash,
      'schema 少一个属性必须算漂移',
    );
    // 取舍如实写出来：**签名材料 = 名字 + 输入 schema**，不含 description。
    // 理由：描述是文案，改它不会让上一段产出的 input 失效（漂移的害处从「工具没接住」来）；
    // 代价：只改描述的那种漂移我们**看不见**。要覆盖它就等于把 description 放进材料 ——
    // 但那会让「润色一句描述」也点亮告警。这是有意的，别当 bug 改。
    assert.equal(
      menuSignature([tool('t', { inputSchema: p1 })]).hash,
      menuSignature([tool('t', { inputSchema: p1, description: '换了句描述' })]).hash,
      'description 不参与签名（有意）',
    );
  });

  it('menuSignature：名字清单有界（超长菜单截断并带省略标记）', () => {
    const many = Array.from({ length: 200 }, (_, i) => tool(`tool_${i}`));
    const { names } = menuSignature(many);
    assert.ok(names.length <= 512 + 16, `名字清单必须有界，实际 ${names.length}`);
    assert.match(names, /…\(\+\d+\)$/, '截断要带省略标记（不静默丢工具名）');
  });

  it('detectMenuDrift：全在册 ⇒ 空；缺的按名字去重排序、tool_use_id 逐条保留', () => {
    // 类型跟着函数签名走（不用 `as never`：那会把 `.slice` 也变成 never，实测被
    // typecheck:tests 拦下 —— 2026-09-27）
    type Uses = Parameters<typeof detectMenuDrift>[0];
    const uses: Uses = [
      { type: 'tool_use', id: 'u1', name: 'ghost', input: {} },
      { type: 'tool_use', id: 'u2', name: 'alpha', input: {} },
      { type: 'tool_use', id: 'u3', name: 'ghost', input: {} },
      { type: 'tool_use', id: 'u4', name: 'beta', input: {} },
    ];
    assert.deepEqual(detectMenuDrift(uses.slice(1, 2), [tool('alpha')]), {
      missing: [],
      toolUseIds: [],
    });
    const d = detectMenuDrift(uses, [tool('alpha')]);
    assert.deepEqual(d.missing, ['beta', 'ghost'], '去重 + 排序');
    assert.deepEqual(d.toolUseIds, ['u1', 'u3', 'u4'], 'tool_use_id 逐条保留（同名可被引用多次）');
  });

  it('detectMenuDrift：`resultSchema` 在场时隐藏的 submit_result 不算漂移（不在场则算）', () => {
    type Uses = Parameters<typeof detectMenuDrift>[0];
    const uses: Uses = [{ type: 'tool_use', id: 'u1', name: 'submit_result', input: {} }];
    assert.deepEqual(detectMenuDrift(uses, [], { resultSchema: OBJ }).missing, []);
    assert.deepEqual(
      detectMenuDrift(uses, []).missing,
      ['submit_result'],
      '阴性对照：没开 resultSchema 时它就是个陌生名字',
    );
  });
});

describe('续跑时的菜单漂移（把静默变可见）', () => {
  it('工具被删 ⇒ menu.drift 事件 + 父 span 属性 + console.warn；run 仍照常收尾', async () => {
    const messages = await suspendMessages();
    const { warnings, value: r2 } = await captureWarn(() =>
      runAgent({
        messages: messages as never,
        client: mockClient([endTurnMsg('（模型自己编了个结果）')]).client,
        tools: [tool('safe')], // ← 部署时 danger 被删了：上一段的未决 tool_use 现在无人接
      }),
    );

    // ① 事件（时间线 / 任务流）
    const drift = eventsOf(r2.trace.spans, 'menu.drift');
    assert.equal(drift.length, 1, '恰好一条 menu.drift');
    assert.deepEqual(drift[0]!.body, {
      missing: ['danger'],
      tool_use_ids: ['tu-danger'],
      menu_size: 1,
    });
    // ② 属性（可查询：TaskRecord.result.trace 里带得到）
    assert.equal(rootOf(r2.trace).attributes['menu.drift'], 'missing:danger');
    // ③ console.warn（运维面立即看见）
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /菜单漂移/);
    assert.match(warnings[0]!, /danger/);

    // 本轮取舍：**不判失败**（挂起是合法态、改代码是发布常态）。run 照常收尾，
    // 该 tool_use 走既有 unknown_tool 路径 —— 静默被打破的是「没人知道」这一层。
    assert.equal(r2.stopReason, 'end_turn');
    assert.equal(r2.error, undefined);
    const out = eventsOf(r2.trace.spans, 'tool.output')[0]!.body as Record<string, unknown>;
    assert.equal(out.errorKind, 'unknown_tool');
    assert.equal(out.tool, 'danger');
  });

  it('阴性对照：工具都在 ⇒ 一个信号都没有，且那批工具真执行了', async () => {
    const messages = await suspendMessages();
    let executed = 0;
    const { warnings, value: r2 } = await captureWarn(() =>
      runAgent({
        messages: messages as never,
        client: mockClient([endTurnMsg('做完了')]).client,
        tools: [
          tool('danger', {
            approval: 'required',
            run: () => {
              executed++;
              return '已执行';
            },
          }),
        ],
        approvals: { 'tu-danger': { approved: true } },
      }),
    );
    assert.equal(eventsOf(r2.trace.spans, 'menu.drift').length, 0, '菜单没变就不该报漂移');
    assert.equal('menu.drift' in rootOf(r2.trace).attributes, false);
    assert.deepEqual(warnings, []);
    assert.equal(executed, 1, '工具在册 ⇒ 正常执行（这条同时证明上面那条不是「永远不报」）');
    assert.equal(r2.stopReason, 'end_turn');
  });

  it('阴性对照：回合内（不是续跑）不判漂移 —— 那是模型幻觉，走既有 unknown_tool 路径', async () => {
    const { warnings, value: r } = await captureWarn(() =>
      runAgent({
        messages: [{ role: 'user', content: 'go' }], // ← 历史末尾是 user ⇒ 新起一段，不是续跑
        client: mockClient([toolUseMsg('ghost', {}, 'tu-ghost'), endTurnMsg('done')]).client,
        tools: [tool('safe')],
      }),
    );
    assert.equal(eventsOf(r.trace.spans, 'menu.drift').length, 0);
    assert.deepEqual(warnings, []);
    const out = eventsOf(r.trace.spans, 'tool.output')[0]!.body as Record<string, unknown>;
    assert.equal(out.errorKind, 'unknown_tool', '既有路径不变');
  });

  it('run 根记 tools.names / tools.menuHash（与 menuSignature 同源）；无工具不记', async () => {
    const tools = [tool('beta'), tool('alpha')];
    const { result } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client: mockClient([endTurnMsg('ok')]).client,
      tools,
    });
    const sig = menuSignature(tools);
    const attrs = rootOf(result.trace).attributes;
    assert.equal(attrs['tools.names'], sig.names);
    assert.equal(attrs['tools.menuHash'], sig.hash, '不就地写死 —— 与纯件单源');
    assert.equal(attrs['tools.names'], 'alpha,beta');

    const { result: noTools } = await executeRun({
      messages: [{ role: 'user', content: 'go' }],
      client: mockClient([endTurnMsg('ok')]).client,
    });
    const a2 = rootOf(noTools.trace).attributes;
    assert.equal('tools.names' in a2, false);
    assert.equal('tools.menuHash' in a2, false);
  });
});
