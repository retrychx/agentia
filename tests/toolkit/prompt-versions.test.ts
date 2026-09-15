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
