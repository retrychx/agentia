import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultEstimateTokens,
  estimateMessages,
  renderMessages,
  trimToolPairs,
  compactMessages,
  createBudgetPolicy,
} from '../../src/index.js';
// 内部工具（刻意不进公共导出面，故不走 index.js）
import { createTokenCounter } from '../../src/engine/trimming.js';
import type { MessageParam } from '../../src/index.js';

describe('长上下文策略', () => {
  it('defaultEstimateTokens：ASCII 按 4 字符/token，CJK 按 1.5 字/token', () => {
    assert.equal(defaultEstimateTokens('a'.repeat(40)), 10);
    const zh = defaultEstimateTokens('汉'.repeat(30)); // 30 中文字符 ≈ 20 token
    assert.ok(zh >= 18 && zh <= 22, `得到 ${zh}`);
    const mixed = defaultEstimateTokens('a'.repeat(40) + '汉'.repeat(30));
    assert.ok(mixed >= 28 && mixed <= 32, `混合 ${mixed}`);
  });

  it('非 BMP 汉字仍按 CJK 计（正则快路径与逐码点口径逐字一致）', () => {
    // 𠀀 = U+20000（扩展 B），占 2 个 UTF-16 能力。若快路径漏掉增补平面，这里会变成 150。
    assert.equal(defaultEstimateTokens('𠀀'.repeat(300)), 275);
    // emoji 是「非 CJK 的代理对」：不记 CJK，但两个 UTF-16 能力都算进 other
    assert.equal(defaultEstimateTokens('😀'), 1);
    assert.equal(defaultEstimateTokens('a'.repeat(40)), 10);
  });

  it('estimateMessages 累计 role 与内容', () => {
    const n = estimateMessages([{ role: 'user', content: 'a'.repeat(40) }]);
    assert.ok(n > 10 && n < 20, `得到 ${n}`);
  });

  it('trimToolPairs：丢旧工具对、保留最近 keepToolPairs 对', () => {
    const msgs: MessageParam[] = [];
    for (let i = 0; i < 5; i++) {
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: {} }],
      });
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'r' }],
      });
    }
    const trimmed = trimToolPairs(msgs, { keepToolPairs: 2 });
    assert.equal(trimmed.length, 4); // 5 对丢 3 对留 2 对
    assert.ok(JSON.stringify(trimmed).includes('t3'), '保留的是最近的工具对');
    assert.ok(!JSON.stringify(trimmed).includes('t0'));
    // 无需裁剪时返回原数组引用
    assert.equal(trimToolPairs(trimmed, { keepToolPairs: 2 }), trimmed);
  });

  it('compactMessages：旧前缀变摘要并入尾段首条 user', async () => {
    const msgs: MessageParam[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `m${i}`,
    }));
    const out = await compactMessages(msgs, {
      keepRecent: 2,
      summarize: (h) => `SUM(${h.length})`,
    });
    assert.equal(out.length, 2); // 摘要并入尾段首条普通 user + 末尾 assistant
    assert.ok(JSON.stringify(out[0]).includes('SUM('));
    assert.ok(JSON.stringify(out[1]).includes('m9'));
  });

  it('createBudgetPolicy：预算内原样放行；超预算先裁剪；滞回防连续压缩', async () => {
    const small: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const policy = createBudgetPolicy({
      budgetTokens: 100,
      summarize: () => 'S',
      keepRecent: 1,
      compactEvery: 2,
    });
    assert.equal(await policy.beforeTurn(small, { iteration: 0, model: 'm' }), small);

    const big: MessageParam[] = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: 'x'.repeat(100) + i,
    }));
    const c1 = await policy.beforeTurn(big, { iteration: 1, model: 'm' });
    assert.ok(JSON.stringify(c1).includes('S'), '应发生压缩');
    // 滞回：距上次压缩 < compactEvery 回合，不再压
    const c2 = await policy.beforeTurn(big, { iteration: 2, model: 'm' });
    assert.ok(!JSON.stringify(c2).includes('S'));
  });

  it('trimToolPairs：非严格交替（连续两条 assistant 带 tool_use）→ 放弃裁剪，不切出孤立块', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'go' },
      // 畸形：两条 assistant 各带 tool_use，结果挤在第三条 user 里
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'x', input: {} }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't0', content: 'r0' },
          { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
        ],
      },
    ];
    // 按相邻性配对会只丢 [1,2] 对，把 t0 的 tool_use 变成孤立块 → 后续请求 400。
    // 检测到畸形即整体放弃裁剪（返回原数组引用）。
    assert.equal(trimToolPairs(msgs, { keepToolPairs: 0 }), msgs);
  });

  it('trimToolPairs：孤立的 tool_result（上一条不是带 tool_use 的 assistant）→ 放弃裁剪', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'go' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'r0' }] },
    ];
    assert.equal(trimToolPairs(msgs, { keepToolPairs: 0 }), msgs);
  });

  it('createBudgetPolicy：keepToolPairs 决定编辑保留的「对数」（与 keepRecent 的「条数」分离）', async () => {
    // 每条消息都很大，确保超预算；5 对工具交换
    const msgs: MessageParam[] = [{ role: 'user', content: 'x'.repeat(400) }];
    for (let i = 0; i < 5; i++) {
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: { pad: 'y'.repeat(200) } }],
      });
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'z'.repeat(200) }],
      });
    }
    // 无摘要器 → 只做 context editing，不会压缩；budgetTokens 故意极小
    const policy = createBudgetPolicy({
      budgetTokens: 10,
      editBeforeCompact: true,
      keepToolPairs: 2,
    });
    const out = await policy.beforeTurn(msgs, { iteration: 0, model: 'm' });
    assert.ok(JSON.stringify(out).includes('t3'), '保留最近 2 对');
    assert.ok(!JSON.stringify(out).includes('t0'), '丢掉更旧的对');
  });

  it('compactMessages：尾段以 assistant 开头 → 摘要单独作首条 user（角色交替合法）', async () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a3' },
      { role: 'assistant', content: 'a4' },
      { role: 'assistant', content: 'a5' },
    ];
    const out = await compactMessages(msgs, { keepRecent: 2, summarize: () => 'SUM' });
    assert.equal(out.length, 3, '摘要 + 尾段 2 条');
    assert.equal(out[0].role, 'user');
    assert.ok(JSON.stringify(out[0]).includes('SUM'));
    assert.ok(JSON.stringify(out[2]).includes('a5'));
  });

  it('compactMessages：cut 落在 tool_result 上 → 整对后移进保留段（不拆散工具对）', async () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'r' }] },
    ];
    // keepRecent=1 → cut=2 正指向 tool_result 那条 user → while 后移到 cut=1
    const out = await compactMessages(msgs, { keepRecent: 1, summarize: () => 'SUM' });
    assert.equal(out.length, 3);
    assert.ok(JSON.stringify(out[0]).includes('SUM'), '旧前缀进摘要');
    assert.ok(!JSON.stringify(out).includes('u0'), 'u0 已被摘要替换');
    assert.ok(JSON.stringify(out).includes('t9'), '工具对整对保留、未被切散');
  });

  it('compactMessages：退到 0 才能保住工具对时 → 放弃压缩（不造孤立 tool_result）', async () => {
    // 工具对落在索引 0/1，且 length === keepRecent + 1 → 初始 cut = 1，再退一步就是
    // 「一条不丢、只多贴一段摘要」。修复前 while 的 `cut > 1` 让它停在 1：tool_use 折进
    // 摘要、尾部留下没有 tool_use 的 tool_result，且与摘要（user）构成连续两条 user ——
    // 两条都是本函数 docstring 明说不产出的形态。
    const msgs: MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
      { role: 'assistant', content: 'a2' },
    ];
    const out = await compactMessages(msgs, { keepRecent: 2, summarize: () => 'SUM' });
    assert.equal(out, msgs, '放弃压缩：原样返回（含数组引用）');
    assert.ok(JSON.stringify(out).includes('t1'), '工具对未被切散');
    assert.ok(!JSON.stringify(out).includes('SUM'), '没有插入摘要');
  });

  /**
   * 工具块完整性：每个 tool_result 的 id 都能在它**之前**找到对应 tool_use。
   * 这是 API 的硬要求（孤儿 tool_result = 下一次请求 400），两条压缩路径都必须满足。
   */
  function assertNoOrphanToolResults(msgs: MessageParam[]): void {
    const seen = new Set<string>();
    for (const m of msgs) {
      if (typeof m.content === 'string') continue;
      // 收窄成结构形状读两个字段即可（内容块联合里有 UnknownContentBlockParam，直接读会报错）
      for (const b of m.content as Array<{ type?: string; id?: string; tool_use_id?: string }>) {
        if (b.type === 'tool_use' && b.id !== undefined) seen.add(b.id);
        if (b.type === 'tool_result') {
          const id = b.tool_use_id ?? '';
          assert.ok(seen.has(id), `孤儿 tool_result: ${id}`);
        }
      }
    }
  }

  it('compactMessages：工具对非相邻（cut 跨过 tool_use）→ 不切出孤儿 tool_result', async () => {
    // tool_use(A) @1 与 tool_result(A) @3 中间夹了一条普通 user 文本。cut=2 正落在那条
    // 文本上 —— 它自己不是 tool_result，所以「只看 messages[cut]」的旧判据放行，@3 的
    // tool_result 留成保留段里的孤儿块（呼应它的 tool_use 已折进摘要）。
    const msgs: MessageParam[] = [
      { role: 'user', content: 'u0' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'A', name: 'x', input: {} }] },
      { role: 'user', content: '夹在中间的普通文本' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'A', content: 'r' }] },
      { role: 'assistant', content: 'a4' },
      { role: 'assistant', content: 'a5' },
    ];
    const out = await compactMessages(msgs, { keepRecent: 4, summarize: () => 'SUM' });
    assertNoOrphanToolResults(out);
    assert.ok(JSON.stringify(out).includes('SUM'), 'cut 退到 1 即可自洽，压缩照做');
    assert.ok(JSON.stringify(out).includes('"A"'), 'tool_use 与它的 tool_result 同在保留段');
  });

  it('compactMessages：孤儿 tool_result 的 tool_use 在索引 0 → 放弃压缩', async () => {
    const msgs: MessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'A', name: 'x', input: {} }] },
      { role: 'user', content: '夹在中间的普通文本' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'A', content: 'r' }] },
      { role: 'assistant', content: 'a3' },
    ];
    // 初始 cut=1 已是不丢消息的下界，仍不自洽 ⇒ 原样返回（同「退到 0 才能保住工具对」）
    const out = await compactMessages(msgs, { keepRecent: 3, summarize: () => 'SUM' });
    assert.equal(out, msgs, '放弃压缩：原样返回（含数组引用）');
    assertNoOrphanToolResults(out);
  });
});

describe('增量 token 计数（createTokenCounter，预算策略的快路径）', () => {
  const sample = (): MessageParam[] => [
    { role: 'user', content: '请处理' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'x', input: { a: 1 } }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't0', content: 'r'.repeat(200) }],
    },
    { role: 'assistant', content: [{ type: 'text', text: '结果' }] },
  ];

  it('与 estimateMessages 全量估算结果一致', () => {
    const msgs = sample();
    assert.equal(createTokenCounter()(msgs), estimateMessages(msgs));
  });

  it('追加消息时只计新增部分，不重算前缀（这正是 O(回合×上下文) → O(上下文) 的落点）', () => {
    let calls = 0;
    const counting = (t: string): number => {
      calls++;
      return defaultEstimateTokens(t);
    };
    const count = createTokenCounter(counting);
    const msgs = sample();
    count(msgs);
    const afterFirst = calls;
    msgs.push({ role: 'user', content: '再加一条' });
    count(msgs);
    const delta = calls - afterFirst;
    // 新增 1 条消息 → 只该估它自己（role 1 次 + 内容 1 次）；全量重算会是 5 条 × 2 次
    assert.ok(delta <= 2, `追加 1 条只该触发 ≤2 次 estimate，实际 ${delta} 次`);
  });

  it('长度变短（被策略裁剪过）时从零重算，不读脏缓存', () => {
    const count = createTokenCounter();
    const msgs = sample();
    count(msgs);
    msgs.length = 2; // 模拟 contextPolicy 原地裁剪后
    assert.equal(count(msgs), estimateMessages(msgs));
  });

  it('createBudgetPolicy 真的用上了它：跨回合估算调用次数不随回合数平方增长', async () => {
    let calls = 0;
    const policy = createBudgetPolicy({
      budgetTokens: 10_000_000, // 预算给满 → 只走快路径，不进裁剪分支
      estimateTokens: (t: string): number => {
        calls++;
        return defaultEstimateTokens(t);
      },
    });
    const msgs = sample();
    await policy.beforeTurn(msgs, { iteration: 1, model: 'm' });
    const first = calls;
    // 再追加 4 条（两回合的量）后重估
    msgs.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
      { role: 'assistant', content: '再一轮' },
      { role: 'user', content: '继续' },
    );
    await policy.beforeTurn(msgs, { iteration: 2, model: 'm' });
    const second = calls - first;
    // 全量重算会是整段历史（8 条）→ 调用数远超新增 4 条
    assert.ok(
      second <= 8,
      `追加 4 条只该估这 4 条（≤8 次调用），实际 ${second} 次 —— 退化成全量重算了`,
    );
  });

  it('同数组、长度不减、但内容被原地换掉 → 必须重算（只有长度判据会漏）', () => {
    const count = createTokenCounter();
    const msgs: MessageParam[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    count(msgs);
    // 原地换掉最后一个元素对象：数组引用没变、长度也没变
    msgs[2] = { role: 'user', content: 'z'.repeat(5000) };
    assert.equal(count(msgs), estimateMessages(msgs), '必须按新内容重算，不能复用旧和');
  });

  it('末元素没变但**首元素**被原地换掉 → 同样重算（首尾双钉，replaceMessages 整换的兜底）', () => {
    const count = createTokenCounter();
    const msgs: MessageParam[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    count(msgs);
    // 只换首元素：数组引用、长度、末元素全都没变 —— 旧判据会读脏计数
    msgs[0] = { role: 'user', content: 'z'.repeat(5000) };
    assert.equal(count(msgs), estimateMessages(msgs), '首元素被换掉必须按新内容重算');
  });

  it('换成另一个数组（新 run / 策略返回新数组）时不复用旧缓存', () => {
    const count = createTokenCounter();
    count(sample());
    const other = [{ role: 'user', content: '完全不同的历史' }] as MessageParam[];
    assert.equal(count(other), estimateMessages(other));
  });
});

/**
 * 图片块 / 未知块：**渲染要有界、估算要不低估**（两个方向刻意分开算）。
 *
 * 此前 `contentToText` 只认 text / tool_use / tool_result，`image` 块落进
 * `default: JSON.stringify(b)` —— 一张 200KB base64 截图被估成 5 万 token，且**整段原样**
 * 交给 `compactMessages` 的摘要模型（真金白银的输入 token + 被噪声毁掉的摘要）。
 * `docs/usage-guide.md` 把 `image` 列为 `ContentBlockParam` 的一等成员，所以这不是边角输入。
 */
describe('图片块 / 未知块：渲染有界、估算不低估', () => {
  const B64 = 'iVBORw0KGgoAAAANSUhEUg'.padEnd(200_000, 'A');
  const imageMsg = (b64: string): MessageParam => ({
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      { type: 'text', text: '（截图）' },
    ] as never,
  });

  it('估算不随 base64 长度增长（图片按尺寸上界，不按文件字节数）', () => {
    const one = estimateMessages([imageMsg(B64)]);
    const four = estimateMessages([imageMsg(B64.repeat(4))]); // 体积 ×4
    assert.equal(four, one, '文件大 4 倍，估算必须一样 —— 图片计费按尺寸、与字节数无关');
    assert.ok(one < 4000, `图片按上界估算（实测 ${one}），不该被 base64 拉成 5 万`);
    assert.ok(one >= 3136, '上界至少覆盖官方「长边缩到 1568px」的单图上界');
  });

  it('渲染只给占位，绝不把 base64 交给摘要模型', async () => {
    const rendered = renderMessages([imageMsg(B64)]);
    assert.ok(!rendered.includes(B64), '渲染文本里不得出现原始 base64');
    // 200000 个 base64 字符 = 150000 字节（4 字符 = 3 字节）—— 占位只报大小，不报内容
    assert.match(rendered, /\[image image\/png ~150000B\]/);
    assert.ok(rendered.length < 200, `渲染必须是有界的（实测 ${rendered.length} 字符）`);

    let seen = '';
    await compactMessages([imageMsg(B64), { role: 'assistant', content: 'x' }], {
      keepRecent: 1,
      summarize: (h) => {
        seen = h;
        return 'S';
      },
    });
    assert.ok(!seen.includes(B64), 'summarize 收到的文本里不得出现原始 base64');
  });

  it('未知块：渲染截断、但估算按**未截断**负载算（低估是危险方向）', () => {
    const msg: MessageParam = {
      role: 'user',
      content: [{ type: 'vendor_future_block', payload: 'x'.repeat(50_000) }] as never,
    };
    const rendered = renderMessages([msg]);
    assert.ok(rendered.length < 400, `渲染要有界（实测 ${rendered.length}）`);
    assert.match(rendered, /共 \d+ 字符/, '截断要留计数，不能静默丢');
    assert.ok(
      estimateMessages([msg]) > 10_000,
      '估算按未截断负载 —— 未知块可能带大 payload，低估会让 maxTotalTokens 迟触发',
    );
  });

  it('URL 图与厂商新源型也有占位（不落到 JSON.stringify）', () => {
    const url = renderMessages([
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } }] as never,
      },
    ]);
    assert.match(url, /\[image url https:\/\/x\.test\/a\.png\]/);
    const other = renderMessages([
      { role: 'user', content: [{ type: 'image', source: { type: 'file_id' } }] as never },
    ]);
    assert.match(other, /\[image file_id\]/);
  });

  it('tool_result **内嵌**图片块：同一条口径（渲染有界、估算按尺寸上界）', async () => {
    // 2026-09-26 复审补。为什么单拎一条：这是**生产里最常见的入图路径** —— 工具返回截图时
    // 正文是 `[image]` 块数组（`ToolResultBlockParam.content` 的联合就给了这个形态），
    // 而不是消息顶层的图片块。此前 `tool_result` 走 `JSON.stringify(content)` ⇒ 实测渲染出
    // **200 086 字符、含原始 base64**、估算 **50 022 token**（与顶层图片块的 3 138 差 16 倍），
    // 而 `docs/usage-guide.md` / `api.html` 已写下「渲染 / 摘要侧只给 `[image …]` 占位、
    // **不展开 base64**」⇒ 承诺与真路径之间只剩这一个洞（顶层图片有守卫、内嵌没有）。
    const nested: MessageParam = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
          ],
        },
      ],
    } as never;

    const rendered = renderMessages([nested]);
    assert.ok(!rendered.includes(B64), '渲染文本里不得出现内嵌图片的原始 base64');
    assert.ok(rendered.length < 400, `渲染必须有界（实测 ${rendered.length} 字符）`);
    assert.match(rendered, /\[image image\/png ~150000B\]/, '内嵌图片也要给占位');
    const tokens = estimateMessages([nested]);
    assert.ok(
      tokens >= 3136,
      `内嵌图片必须按尺寸**上界**估（实测 ${tokens}）—— 退回「按占位文本估」只有十几个 token，会低估成本`,
    );
    assert.ok(tokens < 4000, `内嵌图片按尺寸上界估（实测 ${tokens}，旧实现是 5 万）`);
    // 与顶层图片块**同一条口径**：两种形状的估算差只该是块自身的开销。
    // 旧实现差 16 倍（50 022 vs 3 138）—— 那意味着预算行为随「图片挂在哪里」漂移。
    const topTokens = estimateMessages([imageMsg(B64)]);
    assert.ok(
      Math.abs(tokens - topTokens) <= 3,
      `内嵌与顶层两种形状的估算必须同口径（实测 ${tokens} vs ${topTokens}）`,
    );

    // 真路径：摘要器收到的正文同样不得含 base64（`compactMessages` 把 `renderMessages`
    // 的产物整段交给 summarize —— 这就是「真金白银」那一跳）
    let seen = '';
    await compactMessages([nested, { role: 'assistant', content: 'x' }], {
      keepRecent: 1,
      summarize: (h) => {
        seen = h;
        return 'S';
      },
    });
    assert.ok(!seen.includes(B64), 'summarize 收到的文本里不得出现内嵌图片的原始 base64');

    // 副作用对照：**纯文本**正文的渲染口径不许被改写（既有形态仍是 JSON 字符串化）
    const plain = renderMessages([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }],
      } as never,
    ]);
    assert.match(plain, /"r"/, '文本正文照旧 —— 这条用来防「顺手把老口径也改了」');
  });

  it('tool_use 的参数：渲染有界（blob 型参数不许灌进摘要器）、估算仍按未截断负载', () => {
    // 2026-09-26 复审再补 —— 同一个「载荷型结构」家族里还剩这一处：**工具参数**。
    // `write_file` 的正文、`screenshot` 的 base64、大 JSON 参数都从这里进渲染，
    // 而它此前是裸 `JSON.stringify(tu.input)`（无上界），与上面两个洞同一类。
    const B64ARG = 'iVBORw0KGgo'.padEnd(200_000, 'A');
    const big: MessageParam = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: { data: B64ARG } }],
    } as never;

    const rendered = renderMessages([big]);
    assert.ok(!rendered.includes(B64ARG), '参数里的 base64 不得原样进渲染');
    assert.ok(rendered.length < 2200, `渲染必须有界（实测 ${rendered.length} 字符）`);
    assert.match(
      rendered,
      /…（共 \d+ 字符）/,
      '截断要留计数 —— 静默丢会让摘要以为参数本来就这么短',
    );
    // ⚠️ **估算方向相反**：按未截断的参数算（低估 ⇒ `maxTotalTokens` 迟触发）。
    const tokens = estimateMessages([big]);
    assert.ok(tokens > 10_000, `估算按未截断参数（实测 ${tokens}）—— 渲染有界 ≠ 估算有界`);

    // 阳性对照的另一半：**小参数不许被截断**（否则「一律截断」也能满足上面几条，
    // 而把正常调用的参数也截掉会实打实地毁掉摘要质量）
    const small = renderMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'src/x.ts' } }],
      },
    ] as never);
    assert.match(small, /read_file\(\{"path":"src\/x\.ts"\}\)/, '小参数原样渲染，无截断、无计数');
  });

  it('字符串正文里的纯载荷长串：渲染折叠（留计数）、估算仍按未截断算', async () => {
    // 2026-09-27。补的是「纯文本刻意不截断」留下的**最后一个口子**，而它由框架自己的转换
    // 路径制造：`tool-events.ts` 的 `toolResultBlock()` 对任何返回值走 `stringifySafe` ⇒
    // 工具把截图 base64 当**字符串**返回时，正文形态是字符串（不是块数组），于是绕过上面
    // 三条封顶（图片占位 / 未知块 200 / 参数 2000）整段进摘要器。
    // 实测（本轮，见下方断言读数）：200 043 字符 / 50 012 token —— 而顶层图片块是 37 / 3 142。
    const B64STR = 'iVBORw0KGgoAAAANSUhEUg'.padEnd(200_000, 'A');
    const msg: MessageParam = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: JSON.stringify({ type: 'base64', data: B64STR }),
        },
      ],
    } as never;

    const rendered = renderMessages([msg]);
    assert.ok(!rendered.includes(B64STR), '载荷不得原样进渲染');
    assert.ok(rendered.length < 400, `渲染必须有界（实测 ${rendered.length} 字符）`);
    assert.match(
      rendered,
      /载荷 \d+ 字符已折叠/,
      '折叠要**留计数** —— 静默丢会让摘要以为那里本来就没东西',
    );
    // 方向与另外三处一致：**渲染折叠 ≠ 估算折叠**（低估 ⇒ `maxTotalTokens` 迟触发）。
    const tokens = estimateMessages([msg]);
    assert.ok(tokens > 10_000, `估算仍按未截断负载（实测 ${tokens}）—— 渲染有界 ≠ 估算有界`);

    // 真路径：摘要器收到的正文同样不得含载荷（`compactMessages` 把 `renderMessages`
    // 的产物整段交给 summarize —— 这就是「真金白银」那一跳）
    let seen = '';
    await compactMessages([msg, { role: 'assistant', content: 'x' }], {
      keepRecent: 1,
      summarize: (h) => {
        seen = h;
        return 'S';
      },
    });
    assert.ok(!seen.includes(B64STR), 'summarize 收到的文本里不得出现原始载荷');
  });

  it('折叠判据只认**载荷**：中文/英文散文、结构化 JSON 一个字都不许折', () => {
    // ⚠️ 这条是上一条的**阳性对照**，也是本判据最要紧的一条。折叠的诱惑是写成「无空白的
    // 长串就折」—— 那会错得很难看：**CJK 与英文散文没有空格也照样是散文**，一段几千字的
    // 中文正文按「无空白」判据就是一个长串，折掉等于让摘要器丢掉最该读的内容。所以判据
    // 必须是**字符集**（base64/hex 集合，不含空格/标点/CJK），而不是「无空白」。
    const cjk = '这是一段中文正文，它没有空格也仍然是散文。'.repeat(300); // 6000 字，无空格
    const en = 'the quick brown fox '.repeat(400); // 9000 字符，带空格
    const json = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ i, name: 'item' })));

    for (const [label, text] of [
      ['中文散文（无空格 —— 只有字符集判据能保住它）', cjk],
      ['英文散文（带空格）', en],
      ['结构化 JSON（含 { " , : 故天然豁免）', json],
    ] as const) {
      const rendered = renderMessages([
        { role: 'user', content: [{ type: 'text', text }] },
      ] as never);
      assert.ok(rendered.includes(text), `${label}必须**一字不折**（整段在场）`);
      assert.ok(!rendered.includes('载荷'), `${label}不该出现折叠标记`);
    }
  });

  it('低于下限的短载荷不许被折（下限是判据的一半，不能只守字符集）', () => {
    // 与上一条同源的对照组：字符集对了、下限丢了照样错 —— 短签名 / 短 hash / 短 base64
    // 长度本来就只有几百到一两千字符，折掉它们是纯粹的噪声（摘要本来读得完）。
    const shortB64 = 'A'.repeat(1000);
    const rendered = renderMessages([
      { role: 'user', content: [{ type: 'text', text: 'sig=' + shortB64 }] },
    ] as never);
    assert.ok(rendered.includes(shortB64), '低于下限的载荷必须原样在场（4000 是下限的另一半）');
    assert.ok(!rendered.includes('载荷'), '短载荷不该出现折叠标记');

    // **边界双侧**：`{4000,}` 是含端点的，3999 与 4000 必须分道扬镳 ——
    // 差一（写成 `{4001,}` 或 `{3999,}`）在别处没有任何一条断言看得见。
    const at3999 = 'A'.repeat(3999);
    const r1 = renderMessages([
      { role: 'user', content: [{ type: 'text', text: at3999 }] },
    ] as never);
    assert.ok(r1.includes(at3999), '3999 字符**不许**折（下限含端点 4000）');
    const at4000 = 'A'.repeat(4000);
    const r2 = renderMessages([
      { role: 'user', content: [{ type: 'text', text: at4000 }] },
    ] as never);
    assert.ok(!r2.includes(at4000), '4000 字符**必须**折（下限含端点）');
    assert.match(r2, /载荷 4000 字符已折叠/, '计数要报真实长度');
  });
});
