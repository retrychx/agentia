/*
 * 续跑读取件的直接单测（src/engine/resume-input.ts）—— loop.ts 拆分第三步。
 *
 * 这两个函数此前只有**端到端**覆盖（经 HITL 挂起 → 恢复的整条链路），而且只在
 * 「正好走到恢复分支」时才会执行。它们的两个性质值得单独钉住：
 *
 *   ① `tailToolUses` **只看末尾一条** —— 它回答的是「这些 tool_use 还没被解决吗」，
 *      而不是「历史里出现过 tool_use 吗」。看错方向 = 把续跑当新对话（重复请求模型、
 *      同一批工具再跑一遍）或反之（一个工具都没声明就发请求）。
 *   ② `textOfParam` 处理的是**请求侧**消息：`content` 可以是裸字符串，块的 `text`
 *      是可选的 —— 与响应侧 Message 的必填 `text` 不是同一个类型（见 engine/text.ts）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tailToolUses, textOfParam } from '../../src/engine/resume-input.js';
import type { MessageParam } from '../../src/core/message.js';

const toolUse = (id: string, name = 'echo') => ({ type: 'tool_use' as const, id, name, input: {} });
const textBlock = (text: string) => ({ type: 'text' as const, text });
const assistant = (content: MessageParam['content']): MessageParam => ({
  role: 'assistant',
  content,
});
const user = (text: string): MessageParam => ({ role: 'user', content: text });

describe('tailToolUses —— 续跑检测', () => {
  it('末尾 assistant 带 tool_use → 返回那些块（顺序保持）', () => {
    const ids = tailToolUses([assistant([toolUse('tu-1'), toolUse('tu-2')])]).map((b) => b.id);
    assert.deepEqual(ids, ['tu-1', 'tu-2']);
  });

  it('只看**末尾**一条：中段有未决 tool_use、末尾是 user ⇒ 不是续跑', () => {
    const history = [assistant([toolUse('tu-1')]), user('工具结果回填后继续')];
    assert.deepEqual(tailToolUses(history), []);
  });

  it('末尾是 assistant 但只有文本块 ⇒ 空数组（那是「模型说完了」，不是续跑）', () => {
    assert.deepEqual(tailToolUses([assistant([textBlock('我说完了')])]), []);
  });

  it('末尾 assistant 的 content 是裸字符串 ⇒ 空数组（不是块数组就没有未决 tool_use）', () => {
    assert.deepEqual(tailToolUses([assistant('裸字符串内容')]), []);
  });

  it('空历史 ⇒ 空数组（新对话的起点）', () => {
    assert.deepEqual(tailToolUses([]), []);
  });

  it('混合块里只挑 tool_use（文本块被忽略）', () => {
    const blocks = tailToolUses([assistant([textBlock('先说一句'), toolUse('tu-9')])]);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].id, 'tu-9');
  });
});

describe('textOfParam —— 续跑落定时取文本', () => {
  it('裸字符串内容原样返回', () => {
    assert.equal(textOfParam(user('就是这句')), '就是这句');
  });

  it('块数组：只取文本块，多块按 `\\n` 连接（引擎口径，保住模型的分段输出）', () => {
    assert.equal(
      textOfParam(assistant([textBlock('第一段'), textBlock('第二段')])),
      '第一段\n第二段',
    );
  });

  it('非文本块被忽略（tool_use 不进文本）', () => {
    const msg = assistant([textBlock('结论：'), toolUse('tu-1')]);
    assert.equal(textOfParam(msg), '结论：');
  });

  it('块的 text 缺席 ⇒ 记空串，不会写出 `undefined`', () => {
    const msg = assistant([{ type: 'text' }, textBlock('后半段')] as MessageParam['content']);
    assert.equal(textOfParam(msg), '\n后半段');
  });

  it('没有任何文本块 ⇒ 空串；content 为空数组 ⇒ 空串', () => {
    assert.equal(textOfParam(assistant([toolUse('tu-1')])), '');
    assert.equal(textOfParam(assistant([])), '');
  });
});
