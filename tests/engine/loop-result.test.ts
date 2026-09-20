/*
 * 循环出口**形状**的直接单测（src/engine/loop-result.ts）—— loop.ts 拆分第二步。
 *
 * 此前 `AgentLoopResult` 的 7 个字段由 `loop.ts` 的五处对象字面量各写一遍，形状只能经
 * 集成测试**间接**看到（而且只看到当次走过的那个出口）。这里把两条成文约定钉成断言：
 *
 *   ① 「字段在场」（`docs/guards.md` 的类型角色表：结果/状态记录一律 `T | undefined`）——
 *      字段**缺席**与字段为 `undefined` 在 JSON / OTLP 上是两回事，消费方按
 *      `result.suspendedMessages === undefined` 判「没挂起」。
 *   ② 四个出口的**语义差异**：挂起不是失败、取消也带结构化 error、抛出必须被翻译、
 *      收尾不判成败（成败由 stopReason 表达）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  abortedResult,
  failedResult,
  finishedResult,
  suspendedResult,
} from '../../src/engine/loop-result.js';
import type { MessageParam } from '../../src/core/message.js';

/** AgentLoopResult 的字段全集（顺序无关，比对时排序） */
const FIELDS = [
  'error',
  'finalText',
  'iterations',
  'pendingApprovals',
  'stopReason',
  'suspendedMessages',
  'typed',
].sort();

const userMsg = (text: string): MessageParam => ({ role: 'user', content: text });

/** suspendedResult 要的 ctx 形状（messages + progress.iterations + typed） */
function ctxOf<T>(messages: MessageParam[], iterations = 3, typed: T | undefined = undefined) {
  return { messages, progress: { iterations }, typed };
}

/** 造一个带数值 status 的错误 —— 与 SDK / 适配器抛出来的形状一致 */
function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

describe('字段在场 —— 形状不变量', () => {
  it('四个出口都把 7 个字段写全（缺席 ≠ undefined）', () => {
    const all = [
      suspendedResult(ctxOf([userMsg('go')]), ['tu-1']),
      abortedResult(),
      failedResult(new Error('boom'), 2),
      finishedResult({ stopReason: 'end_turn', finalText: 'ok', iterations: 1, typed: undefined }),
    ];
    for (const r of all)
      assert.deepEqual(Object.keys(r).sort(), FIELDS, `出口 ${r.stopReason} 的字段不全`);
  });

  it('只有挂起出口才让 suspendedMessages / pendingApprovals 非空', () => {
    const suspended = suspendedResult(ctxOf([userMsg('go')]), ['tu-1']);
    assert.notEqual(suspended.suspendedMessages, undefined);
    assert.notEqual(suspended.pendingApprovals, undefined);
    for (const r of [
      abortedResult(),
      failedResult(new Error('boom'), 2),
      finishedResult({
        stopReason: 'max_iterations',
        finalText: '',
        iterations: 9,
        typed: undefined,
      }),
    ]) {
      assert.equal(r.suspendedMessages, undefined, `${r.stopReason} 不该带挂起历史`);
      assert.equal(r.pendingApprovals, undefined, `${r.stopReason} 不该带待决列表`);
    }
  });
});

describe('suspendedResult —— 挂起（等人）', () => {
  it("stopReason 是 'awaiting_approval'，error 保持 undefined（挂起不是失败）", () => {
    const r = suspendedResult(ctxOf([userMsg('go')]), ['tu-1']);
    assert.equal(r.stopReason, 'awaiting_approval');
    assert.equal(r.error, undefined);
  });

  it('历史是**拷贝**：此后改原数组不影响已挂起的结果，且不是同一引用', () => {
    const messages: MessageParam[] = [userMsg('第一段')];
    const r = suspendedResult(ctxOf(messages), ['tu-1']);
    messages.push(userMsg('挂起后宿主又塞进来的'));
    assert.equal(r.suspendedMessages?.length, 1, '挂起历史不该被后续 push 改动');
    assert.notEqual(r.suspendedMessages, messages, '必须是拷贝，不是同一条数组');
  });

  it('待决 id 列表原样交出（内容一致）', () => {
    assert.deepEqual(suspendedResult(ctxOf([userMsg('go')]), ['tu-1', 'tu-2']).pendingApprovals, [
      'tu-1',
      'tu-2',
    ]);
  });

  it('finalText 缺省空串；给了就用给的（挂起前那回合的文本）', () => {
    assert.equal(suspendedResult(ctxOf([userMsg('go')]), ['tu-1']).finalText, '');
    assert.equal(
      suspendedResult(ctxOf([userMsg('go')]), ['tu-1'], '正要调工具').finalText,
      '正要调工具',
    );
  });

  it('iterations / typed 透传', () => {
    const r = suspendedResult(ctxOf([userMsg('go')], 7, { answer: 42 }), ['tu-1']);
    assert.equal(r.iterations, 7);
    assert.deepEqual(r.typed, { answer: 42 });
  });
});

describe('abortedResult —— 已取消', () => {
  it('恒带结构化 error —— 取消不是失败，但「人取消」与「上游出错」必须可区分', () => {
    const r = abortedResult();
    assert.equal(r.stopReason, 'aborted');
    assert.deepEqual(r.error, { type: 'aborted', message: 'run 已被取消', retryable: false });
  });

  it('iterations 缺省 0，可传实际进度（硬写 0 会谎报「一次模型都没调」）', () => {
    assert.equal(abortedResult().iterations, 0);
    assert.equal(abortedResult(5).iterations, 5);
  });

  it('typed / finalText 为空（取消没有结果可交）', () => {
    const r = abortedResult();
    assert.equal(r.typed, undefined);
    assert.equal(r.finalText, '');
  });
});

describe('failedResult —— 抛出被兜住', () => {
  it('429 → rate_limit 且可重试（出口处完成结构化翻译）', () => {
    const r = failedResult(httpError(429, 'rate limited'), 2);
    assert.equal(r.stopReason, 'error');
    assert.equal(r.error?.type, 'rate_limit');
    assert.equal(r.error?.retryable, true);
  });

  it('400 → api 且不可重试；裸 Error → unknown', () => {
    assert.equal(failedResult(httpError(400), 1).error?.type, 'api');
    assert.equal(failedResult(httpError(400), 1).error?.retryable, false);
    assert.equal(failedResult(new Error('说不清'), 1).error?.type, 'unknown');
  });

  it('iterations 透传（第 3 回合请求失败要报 3，不是 0）', () => {
    assert.equal(failedResult(new Error('boom'), 3).iterations, 3);
  });

  it('finalText / typed 为空（失败没有产物）', () => {
    const r = failedResult(new Error('boom'), 1);
    assert.equal(r.finalText, '');
    assert.equal(r.typed, undefined);
  });
});

describe('finishedResult —— 循环这次结束了（不判成败）', () => {
  it('error 缺省为 undefined 但**字段在场**', () => {
    const r = finishedResult({
      stopReason: 'end_turn',
      finalText: 'ok',
      iterations: 1,
      typed: undefined,
    });
    assert.equal('error' in r, true);
    assert.equal(r.error, undefined);
  });

  it('非正常收尾由调用方把结构化 error 一并给出（max_iterations 一类）', () => {
    const err = { type: 'max_iterations' as const, message: '到顶了', retryable: false };
    const r = finishedResult({
      stopReason: 'max_iterations',
      finalText: '',
      iterations: 40,
      typed: undefined,
      error: err,
    });
    assert.equal(r.stopReason, 'max_iterations');
    assert.deepEqual(r.error, err);
  });

  it('stopReason / finalText / iterations / typed 原样透传', () => {
    const r = finishedResult({
      stopReason: 'stop_sequence',
      finalText: '截断前',
      iterations: 2,
      typed: { a: 1 },
    });
    assert.equal(r.stopReason, 'stop_sequence');
    assert.equal(r.finalText, '截断前');
    assert.equal(r.iterations, 2);
    assert.deepEqual(r.typed, { a: 1 });
  });
});
