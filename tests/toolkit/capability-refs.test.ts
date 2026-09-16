import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SystemPrompt, Tool, SubAgent, Skill } from '../../src/index.js';
import type { SkillContext } from '../../src/index.js';
import type { CapabilityMiddleware } from '../../src/toolkit/middleware.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const OBJ = { type: 'object', properties: {} } as const;
const sys = () => new SystemPrompt().add('role', 'r', true);

/** 取 mock 收到的第 n 次请求的菜单名列表（seen[0]=主 agent，seen[1]=子 agent / skill 子运行） */
const toolNamesAt = (seen: unknown[], n: number): string[] =>
  ((seen[n] as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name).sort();

describe('tools 能力级路径引用（<token>/<能力名>）', () => {
  it('子 agent 只拿到被点名的那一个工具（api 菜单断言）', async () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
      @Tool({ description: 'd', schema: OBJ })
      tool_b(): string {
        return 'b';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['tools/tool_a'] })
      runner_agent(_input: unknown): void {}
    }
    const app = createApp({
      providers: [
        { provide: 'tools', useClass: Tools },
        { provide: 'agents', useClass: Agents },
      ],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('runner_agent', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.deepEqual(toolNamesAt(seen, 1), ['tool_a'], '子 agent 菜单应只含被点名的能力');
  });

  it('skill 的 ctx.llm() 同样只拿到被点名的那一个工具', async () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
      @Tool({ description: 'd', schema: OBJ })
      tool_b(): string {
        return 'b';
      }
    }
    class Skills {
      @Skill({ description: 'd', tools: ['tools/tool_b'] })
      async worker(_input: unknown, ctx: SkillContext): Promise<string> {
        await ctx.llm({ prompt: 'go' });
        return 'done';
      }
    }
    const app = createApp({
      providers: [
        { provide: 'tools', useClass: Tools },
        { provide: 'skills', useClass: Skills },
      ],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('worker', {}),
      endTurnMsg('skill 子运行'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.deepEqual(toolNamesAt(seen, 1), ['tool_b'], 'skill 子运行菜单应只含被点名的能力');
  });

  it('能力级引用仍过中间件 —— 防绕过回归', async () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      inner_tool(): string {
        return 'inner';
      }
      @Tool({ description: 'd', schema: OBJ })
      other_tool(): string {
        return 'other';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['tools/inner_tool'] })
      runner_agent(_input: unknown): void {}
    }
    const calls: string[] = [];
    const mw: CapabilityMiddleware = (call, next) => {
      calls.push(call.capability.name);
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

    const { seen, client } = mockClient([
      toolUseMsg('runner_agent', {}),
      toolUseMsg('inner_tool', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.ok(calls.includes('runner_agent'), '子 agent 调用走中间件');
    // 能力级引用也必须解析到「中间件包装后」的菜单，否则内部工具调用绕过
    // 鉴权/限流/审计（与整片引用同一处既有教训）
    assert.ok(calls.includes('inner_tool'), '能力级引用的内部工具也必须走中间件');
    assert.deepEqual(toolNamesAt(seen, 1), ['inner_tool']);
  });

  it('引用不存在的能力名 → 装配期抛错，消息含 token、能力名与可用名单', () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
      @Tool({ description: 'd', schema: OBJ })
      tool_b(): string {
        return 'b';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['tools/nope'] })
      runner_agent(_input: unknown): void {}
    }
    assert.throws(
      () =>
        createApp({
          providers: [
            { provide: 'tools', useClass: Tools },
            { provide: 'agents', useClass: Agents },
          ],
          system: sys(),
        }),
      /tools 引用 "tools" 中不存在的能力: "nope"（可用: tool_a, tool_b）/,
    );
  });

  it('能力级路径可点名该 provider 的 @Skill / @SubAgent 能力（不止 @Tool）', async () => {
    class Skills {
      @Skill({ description: 'd' })
      helper_skill(): string {
        return 'skill-ok';
      }
    }
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['skills/helper_skill'] })
      runner_agent(_input: unknown): void {}
    }
    const app = createApp({
      providers: [
        { provide: 'skills', useClass: Skills },
        { provide: 'agents', useClass: Agents },
      ],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('runner_agent', {}),
      toolUseMsg('helper_skill', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.deepEqual(toolNamesAt(seen, 1), ['helper_skill']);
  });

  it('混写：整片 token + 能力级路径同时引用', async () => {
    class Tools {
      @Tool({ description: 'd', schema: OBJ })
      tool_a(): string {
        return 'a';
      }
    }
    class Extra {
      @Tool({ description: 'd', schema: OBJ })
      extra_tool(): string {
        return 'extra';
      }
      @Tool({ description: 'd', schema: OBJ })
      extra_hidden(): string {
        return 'hidden';
      }
    }
    class Agents {
      @SubAgent({
        description: 'd',
        schema: OBJ,
        system: 's',
        tools: ['tools', 'extra/extra_tool'],
      })
      runner_agent(_input: unknown): void {}
    }
    const app = createApp({
      providers: [
        { provide: 'tools', useClass: Tools },
        { provide: 'extra', useClass: Extra },
        { provide: 'agents', useClass: Agents },
      ],
      system: sys(),
    });

    const { seen, client } = mockClient([
      toolUseMsg('runner_agent', {}),
      endTurnMsg('子报告'),
      endTurnMsg('主收尾'),
    ]);
    const out = await app.run([{ role: 'user', content: 'go' }], { client });

    assert.equal(out.result.stopReason, 'end_turn');
    assert.deepEqual(toolNamesAt(seen, 1), ['extra_tool', 'tool_a']);
  });

  it('token 部分未注册（含带 / 的路径形态）→ 沿用「未注册 provider」文案', () => {
    class Agents {
      @SubAgent({ description: 'd', schema: OBJ, system: 's', tools: ['ghost/tool_a'] })
      runner_agent(_input: unknown): void {}
    }
    assert.throws(
      () => createApp({ providers: [{ provide: 'agents', useClass: Agents }], system: sys() }),
      /tools 引用未注册 provider: "ghost"/,
    );
  });
});
