import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SystemPrompt, Tool, SubAgent } from '../../src/index.js';
import { defineModule } from '../../src/toolkit/module.js';
import type { UnitMiddleware } from '../../src/toolkit/middleware.js';

const OBJ = { type: 'object', properties: {} } as const;
const sys = () => new SystemPrompt().add('role', 'r', true);

describe('createApp 装配期静态校验', () => {
  it('装配菜单：多 provider 合并收集', () => {
    class A {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
    }
    class B {
      @Tool({ description: 'd', schema: OBJ })
      tool_b(): string {
        return 'b';
      }
    }
    const app = createApp({
      providers: [
        { provide: 'a', useClass: A },
        { provide: 'b', useClass: B },
        { provide: 'cfg', useValue: {} }, // 无单元 provider 不产出菜单
      ],
      system: sys(),
    });
    assert.deepEqual(app.tools.map((t) => t.name).sort(), ['tool_a', 'tool_b']);
  });

  it('菜单重名 → 装配期抛错（四类单元共用命名空间）', () => {
    class A {
      @Tool({ description: 'd', schema: OBJ })
      same(): string {
        return 'a';
      }
    }
    class B {
      @Tool({ description: 'd', schema: OBJ })
      same(): string {
        return 'b';
      }
    }
    assert.throws(
      () =>
        createApp({
          providers: [
            { provide: 'a', useClass: A },
            { provide: 'b', useClass: B },
          ],
          system: sys(),
        }),
      /菜单单元重名.*same/,
    );
  });

  it('@SubAgent tools 引用未注册 provider → 装配期抛错（不延迟到运行时）', () => {
    class M {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['nope'] })
      reviewer(_input: unknown): void {}
    }
    assert.throws(
      () => createApp({ providers: [{ provide: 'm', useClass: M }], system: sys() }),
      /tools 引用未注册 provider: "nope"/,
    );
  });

  it('同 token 重复给出（手动 + 发现混用场景）只收集一份菜单', () => {
    class A {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
    }
    const app = createApp({
      providers: [
        { provide: 'a', useClass: A },
        { provide: 'a', useClass: A }, // 同 token 后者覆盖，菜单不翻倍
      ],
      system: sys(),
    });
    assert.equal(app.tools.length, 1);
  });

  it('toolSources 里写重同一 token：只收一份菜单，不误报「菜单单元重名」', () => {
    class A {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
    }
    // 白名单重复写 token 是笔误，不是单元定义重名：报「菜单单元重名」会把诊断
    // 指向单元（错误来源），真正的问题在这份清单本身
    const app = createApp({
      providers: [{ provide: 'a', useClass: A }],
      toolSources: ['a', 'a'],
      system: sys(),
    });
    assert.deepEqual(app.tools.map((t) => t.name), ['tool_a']);
  });

  it('toolSources 指向未注册 token → 抛错', () => {
    assert.throws(
      () => createApp({ providers: [], toolSources: ['ghost'], system: sys() }),
      /toolSources 指向未注册 provider/,
    );
  });
});

describe('modules 能力包装配（R5）', () => {
  it('模块 providers 并入菜单收集', () => {
    class A {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
    }
    const mod = defineModule({ providers: [{ provide: 'a', useClass: A }] });
    const app = createApp({ modules: [mod], system: sys() });
    assert.deepEqual(app.tools.map((t) => t.name), ['tool_a']);
  });

  it('应用级 providers 覆盖模块级同 token', () => {
    class FromModule {
      @Tool({ description: 'd', schema: OBJ })
      tool_mod(): string {
        return 'mod';
      }
    }
    class FromApp {
      @Tool({ description: 'd', schema: OBJ })
      tool_app(): string {
        return 'app';
      }
    }
    const mod = defineModule({ providers: [{ provide: 'x', useClass: FromModule }] });
    const app = createApp({
      modules: [mod],
      providers: [{ provide: 'x', useClass: FromApp }],
      system: sys(),
    });
    assert.deepEqual(app.tools.map((t) => t.name), ['tool_app']);
    assert.ok(app.container.resolve('x') instanceof FromApp);
  });

  it('middleware 拼接顺序：模块级在前（更外层）', () => {
    class A {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
    }
    const order: string[] = [];
    const mw = (tag: string): UnitMiddleware => (_call, next) => {
      order.push(tag);
      return next();
    };
    const mod = defineModule({
      providers: [{ provide: 'a', useClass: A }],
      middleware: [mw('module')],
    });
    const app = createApp({ modules: [mod], middleware: [mw('app')], system: sys() });
    app.tools[0].run({});
    assert.deepEqual(order, ['module', 'app']);
  });
});
