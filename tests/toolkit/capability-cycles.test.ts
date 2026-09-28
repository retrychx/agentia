import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilityGraph, findCapabilityCycle } from '../../src/toolkit/capability-cycles.js';
import type { CapabilityRefInput } from '../../src/toolkit/capability-cycles.js';

/**
 * 能力引用图的成环检测（装配期纯件，2026-09-28）。
 *
 * 这里只测**纯件**（数据进、节点/环出，不装配 App）：装配期的接线由
 * `capability-refs.test.ts` 从真 `createApp` 那侧钉。分两层是有意的 —— 图算法的边界
 * （引线不该进环、黑节点短路、整片引用扇出）在这里穷尽，装配侧只留「成环会抛」这一条。
 */

const cap = (
  token: string,
  kind: 'subagent' | 'skill',
  name: string,
  refs: string[],
): CapabilityRefInput => ({ token, kind, name, refs });

const labels = (nodes: readonly { label: string }[]): string[] => nodes.map((n) => n.label);

describe('buildCapabilityGraph —— 引用表 → 图', () => {
  it('整片 token 引用扇出到该 provider 上的**每一个**能力（subagent + skill 都算）', () => {
    const graph = buildCapabilityGraph([
      cap('agents', 'subagent', 'runner', ['tools']),
      cap('tools', 'skill', 'helper_skill', []),
      cap('tools', 'subagent', 'sub_runner', []),
    ]);
    assert.deepEqual(labels(graph), [
      '@SubAgent "runner" (agents)',
      '@Skill "helper_skill" (tools)',
      '@SubAgent "sub_runner" (tools)',
    ]);
    assert.deepEqual(
      graph[0]!.callees,
      [graph[1]!.id, graph[2]!.id],
      '整片引用要扇出到两个能力（这正是不成环也要连边的那些）',
    );
    assert.deepEqual(graph[1]!.callees, [], '@Skill 没写 tools ⇒ 无出边');
  });

  it('能力级路径只点名一个；指向 @Tool / 不存在名字的引用**落空**（叶子不可能成环）', () => {
    const graph = buildCapabilityGraph([
      cap('agents', 'subagent', 'runner', ['tools/helper_skill', 'tools/grep_code', 'ghost/x']),
      cap('tools', 'skill', 'helper_skill', []),
    ]);
    assert.deepEqual(
      graph[0]!.callees,
      [graph[1]!.id],
      '只有被点名的能力进图：@Tool（grep_code）与不存在的东西都不是节点',
    );
    assert.deepEqual(graph[1]!.callees, []);
  });

  it('id 用 \\u0000 分隔：token 里出现 #// 之类也不串号', () => {
    const a = buildCapabilityGraph([cap('x#y', 'subagent', 'n', [])])[0]!;
    const b = buildCapabilityGraph([cap('x', 'subagent', 'y#n', [])])[0]!;
    assert.notEqual(a.id, b.id, '不同 (token, kind, name) 组合的 id 必须不同');
  });
});

describe('findCapabilityCycle —— 寻环', () => {
  const find = (inputs: CapabilityRefInput[]) => {
    const cycle = findCapabilityCycle(buildCapabilityGraph(inputs));
    return cycle === undefined ? undefined : labels(cycle);
  };

  it('无环 → undefined（含菱形汇合：同一个节点被两条路到达不算环）', () => {
    assert.equal(
      find([
        cap('p', 'subagent', 'a', ['p/b']),
        cap('p', 'subagent', 'b', ['p/c']),
        cap('p', 'subagent', 'c', []),
      ]),
      undefined,
    );
    assert.equal(
      find([
        cap('p', 'subagent', 'top', ['p/left', 'p/right']),
        cap('p', 'subagent', 'left', ['p/bottom']),
        cap('p', 'subagent', 'right', ['p/bottom']),
        cap('p', 'subagent', 'bottom', []),
      ]),
      undefined,
      '菱形汇合：bottom 被两条路引用，但它没有回边 ⇒ 不是环',
    );
  });

  it('自环（整片引用自己的 provider）→ 返回首尾同一个节点', () => {
    assert.deepEqual(find([cap('agents', 'subagent', 'runner', ['agents'])]), [
      '@SubAgent "runner" (agents)',
      '@SubAgent "runner" (agents)',
    ]);
  });

  it('两节点互引 → a → b → a', () => {
    assert.deepEqual(
      find([cap('p', 'subagent', 'a', ['p/b']), cap('p', 'subagent', 'b', ['p/a'])]),
      ['@SubAgent "a" (p)', '@SubAgent "b" (p)', '@SubAgent "a" (p)'],
    );
  });

  it('环**前面**的引线不进环（否则使用者会去拆错那条边）', () => {
    assert.deepEqual(
      find([
        cap('p', 'subagent', 'entry', ['p/a']),
        cap('p', 'subagent', 'a', ['p/b']),
        cap('p', 'subagent', 'b', ['p/a']),
      ]),
      ['@SubAgent "a" (p)', '@SubAgent "b" (p)', '@SubAgent "a" (p)'],
      '只报 a ↔ b，不报 entry',
    );
  });

  it('skill 与 subagent 混在一条环上（两类能力共用一张图）', () => {
    assert.deepEqual(
      find([
        cap('p', 'subagent', 'agent_x', ['p/skill_y']),
        cap('p', 'skill', 'skill_y', ['p/agent_x']),
      ]),
      ['@SubAgent "agent_x" (p)', '@Skill "skill_y" (p)', '@SubAgent "agent_x" (p)'],
    );
  });

  it('跨 provider 的环同样被抓（环不限于同一个 token）', () => {
    assert.deepEqual(
      find([cap('a', 'subagent', 'one', ['b']), cap('b', 'subagent', 'two', ['a'])]),
      ['@SubAgent "one" (a)', '@SubAgent "two" (b)', '@SubAgent "one" (a)'],
    );
  });
});
