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
    const providers = await discoverProviders(`${fixtures}/units`);
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
    await assert.rejects(discoverProviders(`${fixtures}/nope`), /单元目录不存在/);
  });

  it('非法 default export → 报出形态要求', async () => {
    await assert.rejects(discoverProviders(`${fixtures}/units-broken`), /default export 形态非法/);
  });

  it('入口加载失败 → 报出单元名与入口路径，并保留 cause', async () => {
    const dir = `${fixtures}/units-loadfail`;
    const entry = join(fixtures, 'units-loadfail', 'badunit', 'index.ts');
    await assert.rejects(discoverProviders(dir), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /单元 badunit 入口加载失败/);
      assert.ok(e.message.includes(entry), `错误信息应包含入口路径，实际: ${e.message}`);
      assert.ok(e.cause instanceof Error, '应把原始异常保留在 cause 上');
      return true;
    });
  });

  it('软链目录（pnpm/monorepo）同样识别为单元目录', async () => {
    const real = mkdtempSync(join(tmpdir(), 'agentia-unit-'));
    const root = mkdtempSync(join(tmpdir(), 'agentia-units-'));
    try {
      const unitDir = join(real, 'linked');
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, 'index.ts'), 'export default class Linked {}\n');
      symlinkSync(unitDir, join(root, 'linked'), 'dir');

      const providers = await discoverProviders(root);
      assert.deepEqual(providers.map((p) => p.provide), ['linked'], '软链目录不该被静默漏掉');
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('无入口的目录：跳过但留告警（菜单少单元时可排查）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentia-units-'));
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

  it('发现的单元可直接装配出菜单', async () => {
    const app = await createApp({
      discover: `${fixtures}/units`,
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
      discover: `${fixtures}/units`,
      providers: [{ provide: 'alpha', useClass: Explicit }], // 显式声明应压过 units/alpha/
      system: new SystemPrompt().add('role', 'r', true),
    });
    assert.deepEqual(
      app.tools.map((t) => t.name),
      ['explicit_tool'],
      'units/ 下同名文件夹不得悄悄顶掉调用方手写的 provider',
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
