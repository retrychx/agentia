import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { asset, discoverProviders, createApp, SystemPrompt, Tool } from '../../src/index.js';

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url));

describe('discoverProviders（目录发现）', () => {
  it('类 / Provider / Provider[] 三种 default export 形态', async () => {
    const providers = await discoverProviders(`${fixtures}/capabilities`);
    const byToken = new Map(providers.map((p) => [p.provide, p]));
    // 类 → token = 文件夹名 + useClass
    assert.ok('useClass' in byToken.get('alpha')!);
    // Provider 对象 → 原样（自定义 token）
    assert.ok('useValue' in byToken.get('beta-custom')!);
    // Provider[] → 展开
    assert.ok(byToken.has('g1') && byToken.has('g2'));
    assert.equal(providers.length, 4);
  });

  it('目录不存在 → 明确报错', async () => {
    await assert.rejects(discoverProviders(`${fixtures}/nope`), /能力目录不存在/);
  });

  it('数组形态：目录间顺序 = 入参数组顺序（不跨目录重排）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-multi-'));
    try {
      const a = join(root, 'a');
      const b = join(root, 'b');
      // a 里放 zulu、b 里放 alpha —— 目录内按名排序，目录间按入参顺序
      mkdirSync(join(a, 'zulu'), { recursive: true });
      writeFileSync(join(a, 'zulu', 'index.ts'), 'export default class Z {}\n');
      mkdirSync(join(b, 'alpha'), { recursive: true });
      writeFileSync(join(b, 'alpha', 'index.ts'), 'export default class A {}\n');

      assert.deepEqual((await discoverProviders([a, b])).map((p) => p.provide), ['zulu', 'alpha']);
      assert.deepEqual((await discoverProviders([b, a])).map((p) => p.provide), ['alpha', 'zulu']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('数组里任一目录不存在 → 报错（显式给出的搜索路径不该静默落空）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-multi-'));
    try {
      mkdirSync(join(root, 'real'), { recursive: true });
      await assert.rejects(discoverProviders([root, join(root, 'ghost')]), /能力目录不存在/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('跨目录重名 token → 留告警（装配期后者覆盖，菜单只会剩一个）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-dup-'));
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.join(' '));
    };
    try {
      for (const d of ['tools', 'skills']) {
        mkdirSync(join(root, d, 'weather'), { recursive: true });
        writeFileSync(join(root, d, 'weather', 'index.ts'), 'export default class W {}\n');
      }
      const providers = await discoverProviders([join(root, 'tools'), join(root, 'skills')]);
      assert.equal(providers.length, 2, '两个目录各产出一个 provider（覆盖发生在装配期，不是发现期）');
      assert.ok(
        warns.some((w) => /重名能力 weather/.test(w)),
        `应留重名告警，实际: ${JSON.stringify(warns)}`,
      );
    } finally {
      console.warn = realWarn;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('非法 default export → 报出形态要求', async () => {
    await assert.rejects(discoverProviders(`${fixtures}/capabilities-broken`), /default export 形态非法/);
  });

  it('入口加载失败 → 报出能力名与入口路径，并保留 cause', async () => {
    const dir = `${fixtures}/capabilities-loadfail`;
    const entry = join(fixtures, 'capabilities-loadfail', 'badcapability', 'index.ts');
    await assert.rejects(discoverProviders(dir), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /能力 badcapability 入口加载失败/);
      assert.ok(e.message.includes(entry), `错误信息应包含入口路径，实际: ${e.message}`);
      assert.ok(e.cause instanceof Error, '应把原始异常保留在 cause 上');
      return true;
    });
  });

  it('软链目录（pnpm/monorepo）同样识别为能力目录', async () => {
    const real = mkdtempSync(join(tmpdir(), 'agentia-capability-'));
    const root = mkdtempSync(join(tmpdir(), 'agentia-capabilities-'));
    try {
      const capabilityDir = join(real, 'linked');
      mkdirSync(capabilityDir, { recursive: true });
      writeFileSync(join(capabilityDir, 'index.ts'), 'export default class Linked {}\n');
      symlinkSync(capabilityDir, join(root, 'linked'), 'dir');

      const providers = await discoverProviders(root);
      assert.deepEqual(providers.map((p) => p.provide), ['linked'], '软链目录不该被静默漏掉');
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('无入口的目录：跳过但留告警（菜单少能力时可排查）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-capabilities-'));
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.join(' '));
    };
    try {
      mkdirSync(join(root, 'assets'), { recursive: true });
      writeFileSync(join(root, 'assets', 'note.md'), 'x');
      mkdirSync(join(root, 'real'), { recursive: true });
      writeFileSync(join(root, 'real', 'index.ts'), 'export default class R {}\n');

      const providers = await discoverProviders(root);
      assert.deepEqual(providers.map((p) => p.provide), ['real']);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /\[agentia:discover\].*assets/);
    } finally {
      console.warn = realWarn;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('发现的能力可直接装配出菜单', async () => {
    const app = await createApp({
      discover: `${fixtures}/capabilities`,
      system: new SystemPrompt().add('role', 'r', true),
    });
    assert.deepEqual(app.tools.map((t) => t.name), ['alpha_tool']);
    assert.equal(await app.tools[0].run({}), 'alpha');
  });

  it('discover + 显式 providers：同 token 时显式覆盖发现结果', async () => {
    class Explicit {
      @Tool({ description: 'd', schema: { type: 'object', properties: {} } })
      explicit_tool(): string {
        return 'explicit';
      }
    }
    const app = await createApp({
      discover: `${fixtures}/capabilities`,
      providers: [{ provide: 'alpha', useClass: Explicit }], // 显式声明应压过 capabilities/alpha/
      system: new SystemPrompt().add('role', 'r', true),
    });
    assert.deepEqual(
      app.tools.map((t) => t.name),
      ['explicit_tool'],
      'capabilities/ 下同名文件夹不得悄悄顶掉调用方手写的 provider',
    );
    assert.ok(app.container.resolve('alpha') instanceof Explicit);
  });
});

describe('asset（文本资产加载）', () => {
  it('相对调用模块读取文本', () => {
    const text = asset(import.meta.url, '../fixtures/asset.md');
    assert.ok(text.includes('fixture asset content'));
  });
});

describe('discoverProviders（路径不是目录）', () => {
  it('路径是普通文件 → 明确报「不是文件夹」而非原始 ENOTDIR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-notdir-'));
    const file = join(dir, 'plain.txt');
    writeFileSync(file, 'x');
    try {
      await assert.rejects(discoverProviders(file), /能力目录不是文件夹/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
