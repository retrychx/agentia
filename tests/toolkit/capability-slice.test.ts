import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Prompt, Skill, SubAgent, Tool } from '../../src/index.js';
import type { AgentTool } from '../../src/index.js';
import {
  CAPABILITY_KINDS,
  KIND_SPEC,
  buildCapabilitySlice,
  capabilityCount,
  capabilityToolNames,
  capabilityVersions,
  collectCapabilities,
} from '../../src/toolkit/capability-slice.js';

/**
 * `capability-slice.ts` 的注册表 —— 用**真装饰器**逐类驱动（不是手搭假载荷）。
 *
 * 这里钉的是「按类遍历」这件事本身：四类都在场、每类都被走到、口径（能力名 / 能力数 /
 * 角色提示词 / 版本表）由各自那一行给出。⚠️ 编译期那半（加了 `CapabilityPayloads` 成员
 * 却不给 `KIND_SPEC` 表项 ⇒ `TS2741`）**单测抓不到** —— 它由 `typecheck` 守，
 * 所以这一条别在改动时被当成「有单测就够了」。
 */
class Kitchen {
  @Tool({ description: 'd', schema: { type: 'object', properties: {} } })
  plain(): string {
    return 'p';
  }

  @SubAgent({ description: 'd', system: 'sys', schema: { type: 'object', properties: {} } })
  helper(task: string): string {
    return task;
  }

  @Skill({ description: 'd' })
  procedure(task: string): string {
    return task;
  }

  @Prompt({ description: 'd', version: 'v1' })
  greet(): string {
    return 'hi';
  }
}

describe('能力的按类遍历（capability-slice 注册表）', () => {
  it('CAPABILITY_KINDS 从表的键派生：四类齐全、顺序即遍历顺序', () => {
    // ⚠️ 刻意**不**断言「`CAPABILITY_KINDS` 的键集 == `Object.keys(KIND_SPEC)`」：源码里
    // `CAPABILITY_KINDS = Object.keys(KIND_SPEC)` 就是这个赋值本身（`capability-slice.ts`）⇒
    // 那样的断言恒真（`x === x`），是把一道防线画在纸上（2026-09-29 元评估 F3）。真正的牙齿
    // 是下一行的**键序**断言：加第五类能力则此处红，逼人表态（连同 #184 的 `TS2741` 编译期护栏）。
    assert.deepEqual([...CAPABILITY_KINDS], ['tool', 'subagent', 'skill', 'prompt']);
  });

  it('collectCapabilities：四类都在场（真装饰器收集），键集与表一致', () => {
    const c = collectCapabilities(new Kitchen());
    assert.deepEqual(Object.keys(c).sort(), [...CAPABILITY_KINDS].sort());
    assert.equal(c.tool.length, 1, '@Tool 未被收集');
    assert.equal(c.subagent.length, 1, '@SubAgent 未被收集');
    assert.equal(c.skill.length, 1, '@Skill 未被收集');
    assert.equal(c.prompt.tools.length, 1, '@Prompt 未被收集');
  });

  it('capabilityToolNames / capabilityCount 逐类求和（口径 = 能力名 / 能力数）', () => {
    const c = collectCapabilities(new Kitchen());
    assert.deepEqual(capabilityToolNames(c).sort(), ['greet', 'helper', 'plain', 'procedure']);
    assert.equal(capabilityCount(c), 4, '孤儿告警口径是**能力**数，不是编译出来的工具数');
  });

  it('buildCapabilitySlice：四类都编译成工具，引用提示词由各自那一行给出', () => {
    const c = collectCapabilities(new Kitchen());
    const owners: string[] = [];
    // 记的是**调用 resolve 的那一刻**给的提示词（thunk 是延迟的 —— 引用解析发生在运行期）
    const resolve = (owner: string): (() => AgentTool[]) => {
      owners.push(owner);
      return () => [];
    };
    const tools = buildCapabilitySlice(c, resolve);
    assert.deepEqual(tools.map((t) => t.name).sort(), ['greet', 'helper', 'plain', 'procedure']);
    assert.deepEqual(
      owners.sort(),
      ['@Skill "procedure"', '@SubAgent "helper"'],
      '引用提示词是那两类自己的口径（@Tool / @Prompt 没有能力引用 —— 遍历时不该替它们造一个）',
    );
  });

  it('capabilityVersions：只有 @Prompt 进表（另外三类的 versions 缺省 = 本类不参与）', () => {
    const c = collectCapabilities(new Kitchen());
    assert.deepEqual(capabilityVersions(c), { greet: 'v1' });
    assert.equal(KIND_SPEC.tool.versions, undefined, '@Tool 不该有版本表');
    assert.equal(KIND_SPEC.subagent.versions, undefined, '@SubAgent 不该有版本表');
    assert.equal(KIND_SPEC.skill.versions, undefined, '@Skill 不该有版本表');
  });

  it('空 provider：四类都在场但都是空（缺席与空是两件事 —— 遍历不踩 undefined）', () => {
    class Empty {}
    const c = collectCapabilities(new Empty());
    assert.equal(capabilityCount(c), 0);
    assert.deepEqual(capabilityToolNames(c), []);
    assert.deepEqual(
      buildCapabilitySlice(c, () => () => []),
      [],
    );
    assert.equal(capabilityVersions(c), undefined);
  });
});
