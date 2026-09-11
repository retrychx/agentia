import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SystemPrompt } from '../../src/index.js';

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
