/**
 * Agentia —— SSE 逐行分帧（**单源**）。
 *
 * Anthropic 与 OpenAI 兼容端点的事件流都是「一行一条 `data:`」（不需要处理跨行
 * payload），两个适配器此前各写了一份**逐字相同**的 `sseLines`。合并的意义不止整洁：
 * `finally` 里的 `reader.cancel()` 是「提前 break（abort / `[DONE]`）时底层流仍被回收」
 * 的唯一保证 —— 这份代码在两处各存一份，漏改一处就是一处泄漏（读锁不释放，连接挂着）。
 *
 * 只做分帧，不解释协议：空行照常 yield，是不是 `data:` 前缀、要不要认 `[DONE]`
 * 全由调用方判。
 *
 * core 是叶子层：本文件零 import（只用全局的 `ReadableStream` / `TextDecoder`）。
 */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        yield buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
      }
    }
    // 末尾没有换行收尾的残行也要交出去（不是所有端点都补 \n）
    if (buf) yield buf.replace(/\r$/, '');
  } finally {
    // 提前 break（abort / [DONE]）时释放读锁，否则流不会被回收
    try {
      await reader.cancel();
    } catch {
      /* 已结束/已取消 */
    }
  }
}
