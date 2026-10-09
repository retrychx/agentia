/**
 * 假模型端点 —— 给 `scripts/check-run-guards.sh` 用，**只为一件事服务**：
 * 在**不花钱、不碰 Docker、不碰真模型**的前提下，把 `src/run.ts` 的两种「非能力失败」
 * 造出来。它是那份检查的**病例制造机**，不是通用 mock。
 *
 * 五种模式（env `MODE`）：
 *   tool     → 每轮都回一个 `run_command` 的 tool_call。agent 永远「有事干」
 *              ⇒ 只要 `AGENTIA_MAX_ITERATIONS` 给小，就必然撞上限。
 *   text     → 第一轮就回纯文本 ⇒ 正常 `end_turn`（**反向对照**：不该被任何守卫拦）。
 *   zero     → 正常文本，但 `usage` 报 0 token ⇒ 造出「一次成功的模型调用都没有」那一种
 *              （`run.ts` 的第一条守卫，退出码 2）。
 *   flaky500 → 第一轮正常回 tool_call（tokens > 0），第二轮起恒 500 ⇒
 *              「跑了一半然后端点持续故障」：重试耗尽后 `stop=error error=server`，
 *              是 exit 4 守卫的病例（零 token 守卫**接不住**它 —— 已经有过成功调用）。
 *   ctx400   → 同上，但第二轮起恒 400「prompt is too long」⇒ `stop=error error=api`，
 *              上下文超长是 api 类里唯一算基础设施的子类（框架缺省不裁剪长上下文）。
 *
 * 为什么不用框架自带的 `scriptedClient`（`src/selftest.ts` 用的那个）：
 * 这里要验的是 **`run.js` 这个进程的退出码**，只能跨进程观察 ⇒ 必须走真 HTTP。
 * selftest 验的是「转换器产出合不合 Harbor 的 schema」，两件事不重叠。
 *
 * 端点路径与 `src/integrations/openai.ts` 对齐（`${baseURL}/v1/chat/completions`）——
 * 上游一改这里就会 404，检查会当场红，不会静默变成「模型没答」。
 */
import { createServer } from 'node:http';

const mode = process.env.MODE ?? 'tool';
if (!['tool', 'text', 'zero', 'flaky500', 'ctx400'].includes(mode)) {
  process.stderr.write(`MODE 只能是 tool / text / zero / flaky500 / ctx400，收到 ${mode}\n`);
  process.exit(2);
}

let turn = 0;
const server = createServer((req, res) => {
  if (!req.url?.endsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `unexpected path ${req.url}` }));
    return;
  }
  req.resume();
  req.on('end', () => {
    turn += 1;
    // 持续故障病例：第一轮正常（造出 tokens > 0 与一条在飞的 tool_call），之后恒故障。
    // 错误体走 OpenAI 兼容形态 —— `src/integrations/openai.ts` 会把 body 前 200 字符
    // 拼进报错 message，run.ts 的上下文超长判据认的就是这段文本。
    if (mode === 'flaky500' && turn > 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream overloaded', type: 'server_error' } }));
      return;
    }
    if (mode === 'ctx400' && turn > 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'prompt is too long: 250000 tokens > 200000 maximum',
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
          },
        }),
      );
      return;
    }
    const wantsTool = mode === 'tool' || mode === 'flaky500' || mode === 'ctx400';
    const payload = {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-chat',
      choices: [
        {
          index: 0,
          message: wantsTool
            ? {
                role: 'assistant',
                content: 'next step',
                tool_calls: [
                  {
                    id: `call_${turn}`,
                    type: 'function',
                    // `run_command` 是示例 ShellTools 的工具名（`src/bash.ts`）；名字写错会变成
                    // 「未知工具」错误回合，撞出来的就不是循环上限了 —— 这条检查会因此失真。
                    function: {
                      name: 'run_command',
                      arguments: JSON.stringify({ command: 'true' }),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: 'All done. Nothing else to do.' },
          finish_reason: wantsTool ? 'tool_calls' : 'stop',
        },
      ],
      usage:
        mode === 'zero'
          ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          : { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});
