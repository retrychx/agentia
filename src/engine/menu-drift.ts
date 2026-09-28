/**
 * 菜单漂移（R8 候选 3 / durable 调研 §4.1 + §6 候选 3）—— **纯判定**，两个函数各管一件事：
 *
 *   ① `menuSignature`：把「这一段的菜单长什么样」压成两样东西 —— 给人读的名字清单
 *      与给比对用的摘要。落 run 根（见 loop.ts），与 `prompts.versions` 同一动机：
 *      「质量回归能定位到具体菜单版本」。摘要**覆盖输入 schema**，所以「工具还在、
 *      签名变了」也能被两段签名比出来 —— ⚠️ 但比对是**离线的**：跨段 hash 对比由
 *      人 / 外部工具做（trace 里两段 run 根各有一份签名），续跑入口**不自动比**；
 *      自动的只有 ② 的名字级检查。
 *   ② `detectMenuDrift`：**续跑**时未决 tool_use 引用的工具，在当前菜单里还找不找得到。
 *
 * 为什么单独成件：这两个判定是「菜单变了」这件事的**唯一口径**，混在 900 行的 loop.ts
 * 里只能靠注释约定（本仓正在把这类纯判定陆续外移，见 AGENTS.md 的 engine 段）。
 *
 * ⚠️ 与「模型中途编了一个不存在的工具名」不是一回事：那个是幻觉、模型拿一句
 * `unknown tool` 就能自我修正（turn.ts 的既有路径，已钉现状）；这里只管**续跑**时
 * 名字对不上 —— 那是我们的部署动作把一条在飞 run 的意图作废了。两者的动作不同，
 * 别把本件接进回合内的工具执行路径。
 */
import { createHash } from 'node:crypto';
import { truncateWithMark } from '../core/json.js';
import type { ToolUseBlock } from '../core/message.js';
import type { AgentTool } from '../core/tool.js';
import { SUBMIT_RESULT } from './turn.js';

/** 名字清单的字符上限：trace 属性要读得懂，也要有界（菜单可能几十个工具） */
const NAMES_CAP = 512;

/**
 * schema 的**规范序列化**：对象键排序、递归、丢掉 `undefined`。
 *
 * 只做「同一份 schema 得到同一个串」，**不做语义等价** —— `{a:1}` 与 `{a:1,required:[]}`
 * 是两份不同的 schema，就该算出不同签名。漂移的判据宁可敏感（多报一次签名变化），
 * 不要漏（漏了就是 G4 那个静默）。
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * 菜单签名：`names` 给人读（截断 + 省略标记），`hash` 给比对。
 *
 * 摘要材料 = 排序后的 `名字 \0 规范 schema`，所以①与菜单顺序无关（`tools` 数组顺序
 * 变了不算漂移）；②任一工具的 schema 变了就算漂移。用 sha1 截 12 位而不是自造哈希：
 * 碰撞在这里是**静默失效**（两段不同的菜单判成同一段），不值得为省一个内置模块自造。
 */
export function menuSignature(tools: readonly AgentTool[]): { names: string; hash: string } {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : 1));
  const names = truncateWithMark(sorted.map((t) => t.name).join(','), NAMES_CAP);
  const material = sorted.map((t) => `${t.name}\u0000${canonical(t.inputSchema)}`).join('\u0001');
  const hash = createHash('sha1').update(material).digest('hex').slice(0, 12);
  return { names, hash };
}

/** 续跑时的菜单漂移判定结果 */
export interface MenuDrift {
  /** 未决 tool_use 引用的、当前菜单里**没有**的工具名（去重、排序） */
  missing: string[];
  /** 这些名字对应的 tool_use_id（与 `missing` 不同长：同名可被引用多次） */
  toolUseIds: string[];
}

/**
 * 续跑入口的漂移判定：未决 tool_use 的名字 vs 当前菜单。
 *
 * `resultSchema` 在场时把隐藏的 `submit_result` 当**在册** —— 它是引擎内部追加的提交工具、
 * 从不进 `args.tools`，忘了这一条会把每一次「带 resultSchema 的续跑」都误报成漂移
 * （这正是本函数要 `resultSchema` 而不是让调用方传名字清单的原因：口径只有一份）。
 *
 * 只看**名字**：schema 漂移由签名比对覆盖（`menuSignature` 的 hash 覆盖 schema），
 * 而「输入还合不合法」不该在这里判 —— 那段输入在挂起时**也没**校验过，拿它当漂移证据
 * 是误报（模型本就可以给一份不合法的入参）。
 */
export function detectMenuDrift(
  uses: readonly ToolUseBlock[],
  tools: readonly AgentTool[],
  opts: { resultSchema?: unknown } = {},
): MenuDrift {
  const known = new Set(tools.map((t) => t.name));
  if (opts.resultSchema !== undefined) known.add(SUBMIT_RESULT);
  const missing = new Set<string>();
  const toolUseIds: string[] = [];
  for (const use of uses) {
    if (known.has(use.name)) continue;
    missing.add(use.name);
    toolUseIds.push(use.id);
  }
  return { missing: [...missing].sort(), toolUseIds };
}
