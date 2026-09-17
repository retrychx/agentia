import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, Prompt, SystemPrompt } from '../../src/index.js';
import { collectPromptEntries } from '../../src/toolkit/prompt.js';
import { mockClient, endTurnMsg } from '../helpers.js';

const sys = () => new SystemPrompt().add('role', 'r', true);

const rootOf = (trace: {
  rootSpanId: string;
  spans: Array<{ spanId: string; attributes: Record<string, unknown> }>;
}) => trace.spans.find((s) => s.spanId === trace.rootSpanId)!;

describe('@Prompt 资产版本（R7）', () => {
  it('实例方法与静态方法 @Prompt 带 version 都进表；run 根 prompts.versions 按名排序拼接', async () => {
    class Assets {
      @Prompt({ description: 'd', version: 'git-a1b2' })
      writer_guide(): string {
        return 'guide';
      }

      @Prompt({ description: 'd', name: 'brand_voice', version: 'v3' })
      static brand(): string {
        return 'brand';
      }
    }
    const app = createApp({ providers: [{ provide: 'assets', useClass: Assets }], system: sys() });
    const { client } = mockClient([endTurnMsg('ok')]);
    const { result } = await app.run([{ role: 'user', content: 'hi' }], { client });
    // engine 侧按名排序拼 name@ver：brand_voice 在 writer_guide 之前
    assert.equal(
      rootOf(result.trace).attributes['prompts.versions'],
      'brand_voice@v3,writer_guide@git-a1b2',
    );
  });

  it('collectPromptEntries：版本表以最终菜单名为键（spec.name 覆盖方法名）', () => {
    class Assets {
      @Prompt({ description: 'd', name: 'renamed_asset', version: 'v1' })
      asset(): string {
        return 'a';
      }
    }
    const { tools, versions } = collectPromptEntries(new Assets());
    assert.deepEqual(
      tools.map((t) => t.name),
      ['renamed_asset'],
    );
    assert.deepEqual(versions, { renamed_asset: 'v1' });
  });

  it('缺省无 version 的 @Prompt 不进表；其他能力的版本不受影响', async () => {
    class Assets {
      @Prompt({ description: 'd' }) // 无版本
      plain_asset(): string {
        return 'plain';
      }

      @Prompt({ description: 'd', version: 'v9' })
      versioned_asset(): string {
        return 'versioned';
      }
    }
    const app = createApp({ providers: [{ provide: 'assets', useClass: Assets }], system: sys() });
    const { client } = mockClient([endTurnMsg('ok')]);
    const { result } = await app.run([{ role: 'user', content: 'hi' }], { client });
    assert.equal(rootOf(result.trace).attributes['prompts.versions'], 'versioned_asset@v9');
  });

  it('菜单里没有任何带版本的 @Prompt：不写 prompts.versions attribute', async () => {
    class Assets {
      @Prompt({ description: 'd' })
      plain_asset(): string {
        return 'plain';
      }
    }
    const app = createApp({ providers: [{ provide: 'assets', useClass: Assets }], system: sys() });
    const { client } = mockClient([endTurnMsg('ok')]);
    const { result } = await app.run([{ role: 'user', content: 'hi' }], { client });
    assert.equal('prompts.versions' in rootOf(result.trace).attributes, false);
  });

  it('静态继承：父类静态 @Prompt 带 version，子类装配时版本也在表里', async () => {
    // biome-ignore lint/complexity/noStaticOnlyClass: 测试夹具 —— 静态 @Prompt 是纯静态资产的声明形态（见 prompt.ts 头注）
    class Base {
      @Prompt({ description: 'd', version: 'base-v1' })
      static inherited_asset(): string {
        return 'base';
      }
    }
    class Child extends Base {}
    const app = createApp({ providers: [{ provide: 'c', useClass: Child }], system: sys() });
    assert.deepEqual(
      app.tools.map((t) => t.name),
      ['inherited_asset'],
    );
    const { client } = mockClient([endTurnMsg('ok')]);
    const { result } = await app.run([{ role: 'user', content: 'hi' }], { client });
    assert.equal(rootOf(result.trace).attributes['prompts.versions'], 'inherited_asset@base-v1');
  });

  it('静态与实例 @Prompt 方法名相同但菜单名不同：静态资产不得被静默丢弃', () => {
    // 静态扫描曾拿**实例方法 key** 播种去重集，于是 `static brand()` 撞上实例 `brand()`
    // 就被跳过 —— 丢的恰恰是本来不可能重名的资产（菜单名是 brand_static）。
    class Assets {
      @Prompt({ description: 'd' })
      brand(): string {
        return 'instance';
      }

      @Prompt({ description: 'd', name: 'brand_static' })
      static brand(): string {
        return 'static';
      }
    }
    const { tools } = collectPromptEntries(new Assets());
    assert.deepEqual(
      tools.map((t) => t.name),
      ['brand', 'brand_static'],
    );
  });

  it('实例与静态 @Prompt 菜单名真撞了 → 装配期抛「菜单能力重名」（不在这里悄悄吞）', () => {
    class Assets {
      @Prompt({ description: 'd' })
      brand(): string {
        return 'instance';
      }

      @Prompt({ description: 'd' })
      static brand(): string {
        return 'static';
      }
    }
    // 两条都是作者显式声明的资产，收全（各收各的账：ctor 静态 ≠ 原型实例方法）
    assert.deepEqual(
      collectPromptEntries(new Assets()).tools.map((t) => t.name),
      ['brand', 'brand'],
    );
    // spec §7：装配期统一查重、重名即抛 —— 这正是旧行为掩盖掉的那条错误
    assert.throws(
      () => createApp({ providers: [{ provide: 'assets', useClass: Assets }], system: sys() }),
      /菜单能力重名.*brand/,
    );
  });

  it('父子类静态 @Prompt 按「解析后的菜单名」去重：子类改名但同菜单名视为覆写', () => {
    // biome-ignore lint/complexity/noStaticOnlyClass: 测试夹具 —— 静态 @Prompt 是纯静态资产的声明形态（见 prompt.ts 头注）
    class Base {
      @Prompt({ description: 'd', name: 'shared', version: 'v-base' })
      static base_asset(): string {
        return 'base';
      }
    }
    class Child extends Base {
      @Prompt({ description: 'd', name: 'shared', version: 'v-child' })
      static child_asset(): string {
        return 'child';
      }
    }
    const { tools, versions } = collectPromptEntries(new Child());
    // 只留子类那条（沿 ctor 链从最外层往上走，子类先占据该菜单名）
    assert.deepEqual(
      tools.map((t) => t.name),
      ['shared'],
    );
    assert.deepEqual(versions, { shared: 'v-child' });
  });

  it('toolSources 收窄：被排除 provider 的 @Prompt 版本不进表（与主菜单同口径）', async () => {
    class In {
      @Prompt({ description: 'd', version: 'in-v1' })
      in_asset(): string {
        return 'in';
      }
    }
    class Out {
      @Prompt({ description: 'd', version: 'out-v1' })
      out_asset(): string {
        return 'out';
      }
    }
    const app = createApp({
      providers: [
        { provide: 'in', useClass: In },
        { provide: 'out', useClass: Out },
      ],
      toolSources: ['in'],
      system: sys(),
    });
    const { client } = mockClient([endTurnMsg('ok')]);
    const { result } = await app.run([{ role: 'user', content: 'hi' }], { client });
    assert.equal(rootOf(result.trace).attributes['prompts.versions'], 'in_asset@in-v1');
  });
});
