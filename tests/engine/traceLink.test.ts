import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, parseTraceparent } from '../../src/index.js';
import type { Span, TraceContext } from '../../src/index.js';
import { mockClient, endTurnMsg } from '../helpers.js';

/**
 * 入站链路（C：跨进程 / 跨服务关联，spec §9.2）。
 *
 * 这里钉三件事：
 * ① 引擎层：`traceContext` → run 根 span 的一条 `links`；不传则**没有**这个字段
 *    （不是空数组 —— 见 core/trace.ts 的注释）；
 * ② `traceId == runId` 的 1:1 不变量**不被破坏**（上游是被链接、不是被继承）；
 * ③ `app.run`（toolkit）原样透传 —— 这一跳最容易漏，且漏了不报错（仓库里的
 *    signal 曾经就这样静默掉过，见 module.ts 的注释）。
 */

const TURN = (text: string): Record<string, unknown> => endTurnMsg(text);

/** 一个最小的、能真跑一轮的 app（无能力菜单） */
function app() {
  return createApp({ name: 'link-app', system: 'sys' });
}

describe('入站链路 traceContext（spec §9.2 跨进程关联）', () => {
  it('给了 traceContext：run 根记一条 link，且 traceId 仍是自己的新树', async () => {
    const { client } = mockClient([TURN('ok')]);
    const upstream: TraceContext = { traceId: 'up'.repeat(16), spanId: 'f'.repeat(16) };

    const { result } = await app().run([{ role: 'user', content: 'go' }], {
      client,
      traceContext: upstream,
    });

    const root = result.trace.spans.find((s) => s.kind === 'run') as Span;
    assert.deepEqual(root.links, [{ traceId: upstream.traceId, spanId: upstream.spanId }]);
    // 不变量：run 是**新** trace，上游的 traceId 只出现在 links 里，绝不当 parentSpanId
    assert.equal(root.parentSpanId, null);
    assert.notEqual(result.trace.traceId, upstream.traceId);
  });

  it('只有 traceId、没有 spanId：link 里不带 spanId 键（不是空串/undefined）', async () => {
    const { client } = mockClient([TURN('ok')]);

    const { result } = await app().run([{ role: 'user', content: 'go' }], {
      client,
      traceContext: { traceId: 'a'.repeat(32) },
    });

    const root = result.trace.spans.find((s) => s.kind === 'run') as Span;
    assert.equal(root.links?.length, 1);
    assert.deepEqual(root.links?.[0], { traceId: 'a'.repeat(32) });
    assert.equal('spanId' in (root.links?.[0] ?? {}), false);
  });

  it('不给 traceContext：run 根**没有** links 字段（不是空数组）', async () => {
    const { client } = mockClient([TURN('ok')]);

    const { result } = await app().run([{ role: 'user', content: 'go' }], { client });

    const root = result.trace.spans.find((s) => s.kind === 'run') as Span;
    assert.equal('links' in root, false);
  });

  it('app.run 原样透传 traceContext（这一跳漏了会静默丢链路）', async () => {
    const { client } = mockClient([TURN('ok')]);
    const upstream: TraceContext = { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16) };

    const { result } = await app().run([{ role: 'user', content: 'go' }], {
      client,
      traceContext: upstream,
    });

    // 走的是真 app.run → executeRun → runAgent 全链；断言的就是「透传到引擎了」
    const root = result.trace.spans.find((s) => s.kind === 'run') as Span;
    assert.deepEqual(root.links, [upstream]);
  });

  it('link 只落在 run 根，不散到子 span（v1 的口径）', async () => {
    const { client } = mockClient([TURN('ok')]);

    const { result } = await app().run([{ role: 'user', content: 'go' }], {
      client,
      traceContext: { traceId: 'd'.repeat(32) },
    });

    const withLinks = result.trace.spans.filter((s) => s.links !== undefined);
    assert.equal(withLinks.length, 1);
    assert.equal(withLinks[0].kind, 'run');
  });
});

describe('parseTraceparent（W3C traceparent 头）', () => {
  const OK = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  it('合法头 → { traceId, spanId }', () => {
    assert.deepEqual(parseTraceparent(OK), {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
  });

  it('大写 hex 归一化为小写；前后空白容忍（HTTP 头常见脏值）', () => {
    assert.deepEqual(parseTraceparent(`  ${OK.toUpperCase()}  `), {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
  });

  it('版本非 00 仍接受（W3C 前向兼容：只认前四段语义）', () => {
    assert.deepEqual(parseTraceparent(OK.replace(/^00/, '01')), {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
  });

  it('非法形态一律 undefined（缺头 / 空 / 畸形 / 版本 ff / 全零 / 位宽不符）', () => {
    const bad = [
      undefined,
      null,
      '',
      '   ',
      'garbage',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7', // 缺 flags
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra', // 多段
      'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // 版本 ff 非法
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01', // trace 全零
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01', // span 全零
      '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01', // trace 31 位
      '00-4bf92f3577b34da6a3ce929d0e0e47366-00f067aa0ba902b7-01', // trace 33 位
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01', // span 15 位
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0', // flags 1 位
      '0g-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // 非 hex
    ];
    for (const v of bad) {
      assert.equal(parseTraceparent(v), undefined, `应拒绝: ${String(v)}`);
    }
  });
});
