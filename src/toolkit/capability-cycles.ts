/**
 * Agentia —— 能力引用图的**成环检测**（装配期纯件，2026-09-28）。
 *
 * 图的两端：节点 = `@SubAgent` / `@Skill` 能力（`@Tool` / `@Prompt` 是**叶子** —— 它们的
 * 声明里没有 `tools` 字段，不可能再引用别人，所以不进图）；边 = 一个能力的 `tools` 引用
 * 能到达的能力（`'token'` 整片引用 ⇒ 扇出到该 provider 上的**每一个**能力；
 * `'token/名字'` ⇒ 只点名那一个）。
 *
 * **为什么要挡成环**：能力在运行期展开（`subagentToTool(capability, resolveTools)` 的第二个
 * 参数是**延迟求值 thunk**，`wrappedByToken` 在装配期已全部建满）⇒ 一旦成环，模型点一次就是
 * **无限递归**：`maxIterations` 只限每层的**宽度**，深度**没有任何闸**，递归树按
 * 宽度^深度 炸开 —— token 与内存双爆，且要到运行期才显形。DI 容器有环检测
 * （`container/container.ts`），能力图此前没有：同一类「配置错误该在装配期响亮失败」的
 * 不变量，在能力层缺了第二处。
 *
 * 刻意**不**提供「递归深度上限」这类旋钮：检测即拒绝（装配期抛错），要支持真递归得先有
 * 深度闸 —— 两件事必须同时做，先放开闸就是把这个坑重新打开（同款纪律见 `scheduler.ts`
 * 那句「远端单发请拆成多次自检」）。
 *
 * 纯的边界：不碰 DI、不读装饰器注册表、不改任何东西 —— 输入是「收集好的引用表」，
 * 输出是节点或环。所以它能在不装配 App 的情况下被单测。
 */

/** 引用的两种形态（与 `module.ts` 的 `resolveRefTools` 同口径，不各写一份解析） */
export type CapabilityRefKind = 'subagent' | 'skill';

export interface CapabilityRefInput {
  /** 宿主 provider token */
  readonly token: string;
  readonly kind: CapabilityRefKind;
  /** 能力名（菜单名；`collect` 已校验为 `^[A-Za-z0-9_-]{1,64}$`，不含 `/`） */
  readonly name: string;
  /** `tools` 引用原文列表 */
  readonly refs: readonly string[];
}

export interface CapabilityGraphNode {
  /** 稳定标识。用 `\u0000` 分隔而不是 `#`/`/` —— token 是使用者给的任意字符串，那些字符不作保证 */
  readonly id: string;
  /** 给人看的标签（报错文案直接拼它，如 `@SubAgent "runner" (agents)`） */
  readonly label: string;
  /** 它能调用的**能力**节点 id（不含 @Tool/@Prompt：叶子不可能成环） */
  readonly callees: readonly string[];
}

const idOf = (i: CapabilityRefInput): string => `${i.token}\u0000${i.kind}\u0000${i.name}`;

const labelOf = (i: CapabilityRefInput): string =>
  `${i.kind === 'subagent' ? '@SubAgent' : '@Skill'} "${i.name}" (${i.token})`;

/** 引用表 → 有向图（节点顺序与输入一致；`callees` 只含能力节点） */
export function buildCapabilityGraph(inputs: readonly CapabilityRefInput[]): CapabilityGraphNode[] {
  const calleesOf = (refs: readonly string[]): string[] => {
    const out: string[] = [];
    for (const ref of refs) {
      // 按第一个 '/' 切分（能力名不含 '/'，见 collect 的校验）—— 与 resolveRefTools 同口径
      const slash = ref.indexOf('/');
      const token = slash === -1 ? ref : ref.slice(0, slash);
      const name = slash === -1 ? undefined : ref.slice(slash + 1);
      for (const target of inputs) {
        if (target.token !== token) continue;
        // 整片 token（无名字段）⇒ 该 provider 上的每个能力都在子菜单里；
        // 能力级路径 ⇒ 只点名同名的那个。指向 @Tool/@Prompt 的引用在这里自然落空（叶子）。
        if (name === undefined || target.name === name) out.push(idOf(target));
      }
    }
    return out;
  };
  return inputs.map((i) => ({ id: idOf(i), label: labelOf(i), callees: calleesOf(i.refs) }));
}

/**
 * 寻环（DFS + 三色标记）。返回**环上的节点序列**（首尾是同一个节点，便于直接拼成
 * `a → b → a`）；无环返回 `undefined`。
 *
 * 返回路径而不是布尔：这条错误会出现在使用者的启动日志里，他需要知道**从哪切**。
 */
export function findCapabilityCycle(
  nodes: readonly CapabilityGraphNode[],
): CapabilityGraphNode[] | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** 1 = 在当前 DFS 路径上（灰）；2 = 已判定无环（黑） */
  const mark = new Map<string, 1 | 2>();
  const path: CapabilityGraphNode[] = [];

  const visit = (node: CapabilityGraphNode): CapabilityGraphNode[] | undefined => {
    const seen = mark.get(node.id);
    if (seen === 2) return undefined;
    if (seen === 1) {
      // 撞回当前路径上的节点 ⇒ 环；从它**第一次**出现处截出来（前面那段是引线，不是环）
      const at = path.findIndex((n) => n.id === node.id);
      return [...path.slice(at), node];
    }
    mark.set(node.id, 1);
    path.push(node);
    for (const callee of node.callees) {
      const next = byId.get(callee);
      if (next === undefined) continue; // 指向图外（不存在/非能力）：不是环的来源
      const found = visit(next);
      if (found !== undefined) return found;
    }
    path.pop();
    mark.set(node.id, 2);
    return undefined;
  };

  for (const node of nodes) {
    const found = visit(node);
    if (found !== undefined) return found;
  }
  return undefined;
}
