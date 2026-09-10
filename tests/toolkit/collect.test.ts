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
import { unitName } from '../../src/toolkit/collect.js';

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

  it('多层级继承：中间层未装饰 override 继承祖父 spec 且调到中间层实现', async () => {
    class G {
      @Tool({ description: 'd', schema: OBJ })
      x(): string {
        return 'grand';
      }
    }
    class M extends G {
      override x(): string {
        return 'middle';
      }
    }
    class C extends M {}
    const tools = collectTools(new C());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'x');
    assert.equal(await tools[0].run({}), 'middle');
  });

  it('多层级继承：中间层装饰 override 用自己的 spec，祖父不重复命中', () => {
    class G {
      @Tool({ description: 'g', schema: OBJ })
      x(): string {
        return 'grand';
      }
    }
    class M extends G {
      @Tool({ description: 'm', schema: OBJ, name: 'mid_tool' })
      override x(): string {
        return 'middle';
      }
    }
    class C extends M {}
    const tools = collectTools(new C());
    assert.equal(tools.length, 1, '同名装饰方法只命中最近一层');
    assert.equal(tools[0].name, 'mid_tool');
    assert.equal(tools[0].description, 'm');
  });

  it('非函数原型成员与同名 getter 不干扰收集', async () => {
    // 同名 getter（accessor 描述符无 value）：跳过且不标 seen，父类 spec 继续生效
    class P {
      @Tool({ description: 'd', schema: OBJ })
      thing(): string {
        return 'tool';
      }
    }
    class C extends P {
      // @ts-expect-error 故意用 getter 遮蔽父类方法，验证扫描不崩且父类 spec 仍命中
      get thing(): string {
        return 'getter';
      }
    }
    const tools = collectTools(new C());
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'thing');

    // 普通 getter / 非函数成员本身不会被收集成单元
    class G {
      @Tool({ description: 'd', schema: OBJ })
      ok(): string {
        return 'ok';
      }
      get notTool(): number {
        return 1;
      }
    }
    assert.deepEqual(collectTools(new G()).map((t) => t.name), ['ok']);
  });

  it('unitName：symbol 方法名且无显式 name → 抛错文案带符号信息', () => {
    const sym = Symbol('hidden');
    assert.throws(
      () => unitName({}, sym, '@Tool'),
      /@Tool 需要显式 name（方法名为私有符号 Symbol\(hidden\)）/,
    );
    assert.equal(unitName({ name: 'n' }, sym, '@Tool'), 'n', '显式 name 优先');
    assert.equal(unitName({}, 'method', '@Tool'), 'method', '字符串 key 缺省取方法名');
  });

  it('symbol 命名的装饰方法：无显式 name 抛错，有显式 name 正常收集', () => {
    const sym = Symbol('hidden');
    class NoName {
      @Tool({ description: 'd', schema: OBJ })
      [sym](): string {
        return 'x';
      }
    }
    assert.throws(() => collectTools(new NoName()), /@Tool 需要显式 name/);

    class Named {
      @Tool({ description: 'd', schema: OBJ, name: 'hidden_tool' })
      [sym](): string {
        return 'x';
      }
    }
    const tools = collectTools(new Named());
    assert.deepEqual(tools.map((t) => t.name), ['hidden_tool']);
  });
});
