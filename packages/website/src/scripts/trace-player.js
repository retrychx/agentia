/* trace 侧回放游标：按场景脚本的节奏把事件喂给一个 trace 视图。
 *
 * 谁在用：官网 /playground 的模拟演示（onStep 补终端面板与外层状态）、官网首屏的真 trace
 * 自播（onStep 只处理菜单高亮，甚至不传）。**节奏与配对的唯一定义就在这里** ——
 * 两边各写一份必漂移，尤其是 `tool.output` 的归属：出参要挂回【发起它的那个 llm.turn】，
 * 而嵌套能力（subagent / skill）的 result 在它内部所有调用都收口之后才到达，所以只能按栈
 * LIFO 配对；用「最近一次工具调用」会把子代理的结论错配到它内部最后调用的那个工具上。
 *
 * ⚠️ 步骤顺序刻意与它从 playground.js 抽出来之前**逐条一致** —— terminal 与 trace 的相对
 * 次序也是语义（工具步骤是「面板先、trace 后」，收尾步骤是「trace 先、面板后」）：
 *   think → menu → spanStart → spanEnd → llmOpen → stream →
 *   tool[面板→trace] → result[面板→trace] → note → finalOpen → done[trace→面板]
 */
import { fmtArg, rawArg } from '@migor/trace-view';

/**
 * 跑完一遍脚本。返回 true 表示跑完，false 表示中途被取消。
 * `isCancelled` 在每次等待前后都会被查（重播 / 切场景 / 离屏时作废旧循环）。
 */
export async function playScript({ view, script, sleep, onStep, isCancelled }) {
  const startedAt = performance.now();
  let lastTurnId = null; // 最近一个 llm.turn：工具调用按框架语义记成它的事件
  const pending = []; // 未收到 result 的工具调用栈（嵌套能力先内后外收口）
  const gone = () => Boolean(isCancelled?.());

  for (const ev of script) {
    if (gone()) return false;
    if (ev.wait) {
      await sleep(ev.wait);
      if (gone()) return false;
    }
    if (ev.think) await onStep?.(ev);
    if (ev.menu) await onStep?.(ev);
    if (ev.spanStart) {
      view.start(ev.spanStart);
      if (ev.spanStart.kind === 'llm.turn') lastTurnId = ev.spanStart.id;
    }
    if (ev.spanEnd) view.end(ev.spanEnd);
    if (ev.llmOpen) await onStep?.(ev);
    if (ev.stream) await onStep?.(ev);
    if (ev.tool) {
      await onStep?.(ev);
      if (lastTurnId) {
        view.event(
          lastTurnId,
          'tool.input',
          ev.tool.name,
          fmtArg(ev.tool.input),
          true,
          rawArg(ev.tool.input),
        );
      }
      pending.push({ name: ev.tool.name, turnId: lastTurnId });
    }
    if (ev.result) {
      await onStep?.(ev);
      const call = pending.pop();
      if (call && call.turnId) {
        view.event(call.turnId, 'tool.output', call.name, ev.result.text);
      }
    }
    if (ev.note) await onStep?.(ev);
    if (ev.finalOpen) await onStep?.(ev);
    if (ev.done) {
      view.finish(Math.round(performance.now() - startedAt));
      await onStep?.(ev);
    }
  }
  return true;
}
