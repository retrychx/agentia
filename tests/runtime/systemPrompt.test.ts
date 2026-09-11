import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SystemPrompt, createApp, runAgent } from '../../src/index.js';
import { mockClient, endTurnMsg } from '../helpers.js';

describe('SystemPrompt（缓存布局）', () => {
  const sp = () =>
    new SystemPrompt()
      .add('role', '你是流水线主 agent。', true)
      .add('units', '可调度 reviewer 等。', true)
      .add('clock', '当前时间: {now}', false); // volatile

  it('cache=false：拼成单个纯文本（stable + volatile）', () => {
    const out = sp().build({ cache: false }) as string; // cache=false 必为 string，收窄便于断言
    assert.equal(typeof out, 'string');
    assert.ok(out.includes('流水线主 agent') && out.includes('当前时间'));
  });

  it('cache=true：稳定前缀一块打 ephemeral breakpoint，volatile 块在后不带标记', () => {
    const out = sp().build({ cache: true });
    assert.ok(Array.isArray(out) && out.length === 2);
    const [stable, volatile] = out;
    assert.equal(stable.type, 'text');
    assert.equal(stable.cache_control?.type, 'ephemeral');
    assert.ok(stable.text.includes('流水线主 agent') && stable.text.includes('可调度'));
    assert.ok(!stable.text.includes('当前时间'), 'volatile 不污染稳定前缀');
    assert.equal(volatile.type, 'text');
    assert.equal(volatile.cache_control, undefined);
  });

  it('stableText 只含稳定段；add 支持 section 对象形态', () => {
    const s = sp();
    assert.ok(!s.stableText.includes('当前时间'));
    s.add({ name: 'extra', text: '附加段', stable: true });
    assert.ok(s.stableText.includes('附加段'));
  });

  it('无 volatile 时 cache 布局只有稳定块', () => {
    const out = new SystemPrompt().add('role', 'r', true).build({ cache: true });
    assert.ok(Array.isArray(out) && out.length === 1);
  });

  it('空段不产出空 text block；完全无段时回 ""（而非 []）', () => {
    // 只有空文本的稳定段：不能产出「空 text + breakpoint」块
    const empty = new SystemPrompt().add('role', '', true).build({ cache: true });
    assert.equal(empty, '');

    const none = new SystemPrompt().build({ cache: true });
    assert.equal(none, '', 'engine 对 [] 判真会照发一个空 system');
    assert.equal(new SystemPrompt().build(), '');

    // 空稳定段 + 有内容 volatile：只出 volatile 块
    const mixed = new SystemPrompt().add('role', '', true).add('clock', 'now', false).build({ cache: true });
    assert.ok(Array.isArray(mixed) && mixed.length === 1);
    assert.equal((mixed[0] as { text: string }).text, 'now');
  });
});

describe('提示词版本化（D4）', () => {
  const rootOf = (trace: { rootSpanId: string; spans: Array<{ spanId: string; attributes: Record<string, unknown> }> }) =>
    trace.spans.find((s) => s.spanId === trace.rootSpanId)!;

  it('SystemPrompt({ version }) 暴露只读 version；不传则 undefined，add 不改它', () => {
    assert.equal(new SystemPrompt().version, undefined);
    assert.equal(new SystemPrompt({ version: 'v3' }).version, 'v3');
    assert.equal(new SystemPrompt({ version: 'v3' }).add('a', 'b').version, 'v3');
  });

  it('app.run：SystemPrompt 的 version 落到 run 根 attribute `system.version`', async () => {
    const app = createApp({
      name: 'ver-app',
      system: new SystemPrompt({ version: 'git-abc123' }).add('role', 'r', true),
    });
    const { client } = mockClient([endTurnMsg('ok')]);
    const { result } = await app.run([{ role: 'user', content: 'hi' }], { client });
    assert.equal(rootOf(result.trace).attributes['system.version'], 'git-abc123');
  });

  it('单次 system 覆盖时，版本跟当次那个 SystemPrompt 走（不是应用级那个）', async () => {
    const app = createApp({ name: 'ver-app', system: new SystemPrompt({ version: 'v1' }).add('role', 'r') });
    const { client } = mockClient([endTurnMsg('ok')]);
    const { result } = await app.run([{ role: 'user', content: 'hi' }], {
      client,
      system: new SystemPrompt({ version: 'v2-experiment' }).add('role', 'r'),
    });
    assert.equal(rootOf(result.trace).attributes['system.version'], 'v2-experiment');
  });

  it('system 是已拼好的 SystemParam（无版本）时不写该 attribute —— 不写空串冒充实有版本', async () => {
    const app = createApp({ name: 'ver-app', system: 'plain system' });
    const { client } = mockClient([endTurnMsg('ok')]);
    const { result } = await app.run([{ role: 'user', content: 'hi' }], { client });
    assert.equal('system.version' in rootOf(result.trace).attributes, false);
  });

  it('直连 runAgent 时也能显式给 systemVersion（不强制走 SystemPrompt 实例）', async () => {
    const { client } = mockClient([endTurnMsg('ok')]);
    const r = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      client,
      systemVersion: 'manual-1',
    });
    assert.equal(rootOf(r.trace).attributes['system.version'], 'manual-1');
  });
});
