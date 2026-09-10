import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Tool,
  SubAgent,
  Skill,
  Prompt,
  collectTools,
  collectSubAgents,
  collectSkills,
  collectPrompts,
} from '../../src/index.js';

const OBJ = { type: 'object', properties: {} } as const;

describe('collect*（装饰器单元收集）', () => {
  it('@Tool：收集方法、绑定 this、schema/strict 透传', async () => {
    class T {
      prefix = 'p';
      @Tool({ description: 'd', schema: OBJ, strict: true })
      my_tool(): string {
        return `${this.prefix}:ok`;
      }
    }
    const tools = collectTools(new T());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'my_tool');
    assert.equal(tools[0].strict, true);
    assert.equal(await tools[0].run({}), 'p:ok');
  });

  it('继承：父类装饰方法进入子类实例菜单', () => {
    class P {
      @Tool({ description: 'd', schema: OBJ })
      base_tool(): string {
        return 'base';
      }
    }
    class C extends P {}
    assert.deepEqual(collectTools(new C()).map((t) => t.name), ['base_tool']);
  });

  it('override 语义：子类未装饰的 override 继承父类 spec 且调到子类实现', async () => {
    class P {
      @Tool({ description: 'd', schema: OBJ })
      my_tool(): string {
        return 'parent';
      }
    }
    class C extends P {
      override my_tool(): string {
        return 'child';
      }
    }
    const tools = collectTools(new C());
    assert.equal(tools.length, 1);
    assert.equal(await tools[0].run({}), 'child');
  });

  it('@SubAgent / @Skill / @Prompt 各自收集出单元', async () => {
    class M {
      @SubAgent({ description: 'd', schema: OBJ, system: 's' })
      reviewer(_input: unknown): void {}

      @Skill({ description: 'd' })
      async writer(_input: unknown, ctx: { llm(o: { prompt: string }): Promise<{ text: string }> }) {
        const r = await ctx.llm({ prompt: 'x' });
        return r.text;
      }

      @Prompt({ description: 'd' })
      asset(): string {
        return 'volatile';
      }

      @Prompt({ description: 'd2', name: 'brand' })
      static brand(): string {
        return 'const';
      }
    }
    const inst = new M();
    const subs = collectSubAgents(inst);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].name, 'reviewer');

    const skills = collectSkills(inst);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'writer');
    const out = await skills[0].invoke({}, { llm: async () => ({ text: 'llm-done' }) });
    assert.equal(out, 'llm-done');

    const prompts = collectPrompts(inst);
    assert.deepEqual(prompts.map((p) => p.name).sort(), ['asset', 'brand']);
    assert.equal(await prompts.find((p) => p.name === 'brand')!.run({}), 'const');
  });

  it('装饰器拒绝非方法目标', () => {
    assert.throws(
      () => Tool({ description: 'd', schema: OBJ })(() => {}, { kind: 'field', name: 'x' }),
      /只能修饰类方法/,
    );
  });
});
