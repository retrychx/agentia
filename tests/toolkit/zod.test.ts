import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent, Tool, collectTools } from '../../src/index.js';
import type { JsonSchema } from '../../src/index.js';
import { fromZod } from '../../src/toolkit/zod.js';
import { mockClient, toolUseMsg, endTurnMsg } from '../helpers.js';

const Weather = z.object({
  city: z.string(),
  days: z.number().int().min(1).max(7),
});
type Weather = z.infer<typeof Weather>;

// zod 是用户的 peer 依赖：z.toJSONSchema 推导 JSON Schema，fromZod 挂上 safeParse 校验
const weatherSchema = fromZod(z.toJSONSchema(Weather) as JsonSchema, Weather);

describe('zod 可选接入（fromZod）', () => {
  it('非法 input 被 zod 拦下：is_error 含 zod 路径，方法体不进', async () => {
    let called = 0;
    class WeatherTools {
      @Tool({ description: '查天气', schema: weatherSchema })
      get_weather(_input: Weather): string {
        called++;
        return 'sunny';
      }
    }
    const tools = collectTools(new WeatherTools());
    const { seen, client } = mockClient([
      toolUseMsg('get_weather', { city: 123, days: 3 }), // city 应为 string
      endTurnMsg('参数错了'),
    ]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: '北京天气' }],
      tools,
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(called, 0); // 校验拦住，未进方法体

    // 回给模型的 tool_result：is_error，错误信息含 zod 路径 city
    // （seen 里的 messages 是同一数组引用、随回合增长，按 tool_result 块找）
    const msgs = (seen[1] as { messages: Array<{ role: string; content: unknown }> }).messages;
    const tr = msgs
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []) as Array<{ type?: string; is_error?: boolean; content: string }>)
      .find((b) => b.type === 'tool_result')!;
    assert.equal(tr.is_error, true);
    assert.ok(tr.content.includes('invalid input'), tr.content);
    assert.ok(tr.content.includes('city'), tr.content);
  });

  it('合法 input 通过 zod + JSON Schema 子集校验，方法正常执行', async () => {
    class WeatherTools {
      @Tool({ description: '查天气', schema: weatherSchema })
      get_weather(input: Weather): string {
        return `${input.city}:${input.days}天晴`;
      }
    }
    const tools = collectTools(new WeatherTools());
    const { seen, client } = mockClient([
      toolUseMsg('get_weather', { city: '北京', days: 3 }),
      endTurnMsg('北京未来三天晴'),
    ]);
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: '北京天气' }],
      tools,
    });
    assert.equal(result.stopReason, 'end_turn');
    const msgs = (seen[1] as { messages: Array<{ role: string; content: unknown }> }).messages;
    const tr = msgs
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []) as Array<{ type?: string; is_error?: boolean; content: string }>)
      .find((b) => b.type === 'tool_result')!;
    assert.ok(!tr.is_error);
    assert.ok(tr.content.includes('北京:3天晴'), tr.content);
  });

  it('第二参不带 safeParse：fromZod 直接报错', () => {
    assert.throws(() => fromZod({ type: 'object' }, { notZod: true }), /safeParse/);
  });
});
