import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SystemPrompt, Tool, SubAgent } from '../../src/index.js';
import { defineModule } from '../../src/toolkit/module.js';
import type { UnitMiddleware } from '../../src/toolkit/middleware.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

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

  it('嵌套单元（子 agent 内部工具）也走中间件 —— 不绕过鉴权/限流/审计', async () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      inner_tool(): string {
        return 'inner';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['tools'] })
      runner_agent(_input: unknown): void {}
    }
    const calls: string[] = [];
    const mw: UnitMiddleware = (call, next) => {
      calls.push(call.unit.name);
      return next();
    };
    const app = createApp({
      providers: [
        { provide: 'tools', useClass: Tools },
        { provide: 'agents', useClass: Agents },
      ],
      middleware: [mw],
      system: sys(),
    });

    // 主循环 → 调 runner_agent；子 agent 内部 → 调 inner_tool；随后各自 end_turn
    const { client } = mockClient([
      toolUseMsg('runner_agent', {}),
      toolUseMsg('inner_tool', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.ok(calls.includes('runner_agent'), '子 agent 调用走中间件');
    // 修复点：子 agent 的 tools 引用必须解析到「中间件包装后」的菜单，
    // 否则内部工具调用完全绕过中间件（鉴权/限流/审计全失效）
    assert.ok(calls.includes('inner_tool'), '子 agent 内部工具也必须走中间件');
  });
});
