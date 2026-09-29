/**
 * 能力切片 —— **四类能力在装配期的全部差异集中在这一张表里**（外部深评 K2 的收口）。
 *
 * ## 为什么需要它
 *
 * 这四类能力（`@Tool` / `@SubAgent` / `@Skill` / `@Prompt`）的装配差异此前**平行散落在
 * `toolkit/module.ts` 的五处按类分支**里：收集（四个 Map）、可用名单（四路拼接）、
 * `buildSlice`（四路展开）、`@Prompt` 版本表、孤儿能力计数（四路求和）。
 * 后果不是「代码不好看」，而是**新增第五类能力时不会有任何东西报错**：漏改某一处只表现为
 * 「那类能力静默不进菜单 / 不进版本表 / 不计入孤儿告警」，构建与全部用例照样全绿。
 *
 * 现在按类的那五处只剩**一次遍历**，而遍历的面是这张表派生的；新增一类能力的动作变成
 * 「给 `CapabilityPayloads` 加一个成员 + 给 `KIND_SPEC` 加一行」——
 * **`KIND_SPEC` 的类型是映射类型 `{[K in CapabilityKind]: CapabilityKindSpec<K>}` ⇒ 加了
 * payload 不给表项，`tsc` 直接报 `TS2741`（缺属性）**（与 `SUCCESS_STOP_REASON` /
 * `TERMINAL_STATUS` 同款护栏：加成员不表态就构建红，而不是「下次谁发现」）。
 *
 * ⚠️ 两处**刻意不在本表里**（别为了「看起来整齐」搬进来）：
 * - **菜单重名校验**（`module.ts` 最后那段）：它跑在**合并后的工具列表**上，本来就与类别无关，
 *   按类拆开反而要重新拼回去；
 * - **能力引用图**（`capability-cycles`）：只有 `@SubAgent` / `@Skill` 有 `tools` 引用，
 *   另外两类没有「能力引用」这回事 —— 那是**语义上的不对称**，不是漏项。
 */
import type { AgentTool } from '../core/tool.js';
import { collectTools } from './tool.js';
import { collectSubAgents, subagentToTool } from './subagent.js';
import type { SubAgentCapability } from './subagent.js';
import { collectSkills, skillToTool } from './skill.js';
import type { SkillCapability } from './skill.js';
import { collectPromptEntries } from './prompt.js';
import type { CollectedPrompts } from './prompt.js';

/**
 * 四类能力各自的**收集产物** —— 这张表（而不是别处）就是「一类能力」的定义。
 * 加一个成员 = 加一类能力，代价是 `KIND_SPEC` 必须多一行（编译期强制）。
 */
export interface CapabilityPayloads {
  tool: AgentTool[];
  subagent: SubAgentCapability[];
  skill: SkillCapability[];
  prompt: CollectedPrompts;
}

export type CapabilityKind = keyof CapabilityPayloads;

/** 一个 token 上收集到的**全部**类别（每类都在场，空数组也算在场 —— 缺席与空是两件事） */
export type CollectedByKind = { [K in CapabilityKind]: CapabilityPayloads[K] };

/** 解析 `tools` 引用（`'token'` / `'token/能力名'`）—— 由 `module.ts` 注入（它持有 DI 与包装后的菜单） */
export type ResolveRefTools = (owner: string, refs: string[] | undefined) => () => AgentTool[];

/**
 * 一类能力在装配期的**全部差异**。四个方法各自对应 `module.ts` 里原先的一处按类分支；
 * `versions` 可选是因为**只有 `@Prompt` 有资产版本**（另外三类没有「版本」这回事，
 * 缺省 = 本类不参与版本表）。
 */
export interface CapabilityKindSpec<K extends CapabilityKind> {
  /** 从 provider 实例上收集本类能力（对应原先的 `collectX(inst)`） */
  collect(inst: object): CapabilityPayloads[K];
  /** 本类能力编译成的工具（对应 `buildSlice` 里那一路展开） */
  toTools(payload: CapabilityPayloads[K], resolve: ResolveRefTools): AgentTool[];
  /** 本类能力贡献的**工具名**（可用名单 / 与最终菜单名一致的口径） */
  toolNames(payload: CapabilityPayloads[K]): string[];
  /** 本类能力的条数（孤儿能力告警的口径：**能力**数，不是工具数） */
  count(payload: CapabilityPayloads[K]): number;
  /** 资产版本表（只有 `@Prompt` 有）；缺省 = 本类不参与 */
  versions?(payload: CapabilityPayloads[K]): Record<string, string> | undefined;
}

/**
 * 注册表 —— **加一类能力就在这里加一行**。
 *
 * ⚠️ 类型是映射类型（每行各自收窄到自己的载荷类型），所以：
 * ① 少了任何一行 ⇒ `TS2741`；② 行里的方法签名与载荷类型不匹配 ⇒ 当场报错；
 * ③ 遍历代码（下面几个 helper）不需要跟着改 —— 它们从这张表派生。
 */
export const KIND_SPEC: { [K in CapabilityKind]: CapabilityKindSpec<K> } = {
  tool: {
    collect: (inst) => collectTools(inst),
    toolNames: (tools) => tools.map((t) => t.name),
    count: (tools) => tools.length,
    toTools: (tools) => tools,
  },
  subagent: {
    collect: (inst) => collectSubAgents(inst),
    toolNames: (caps) => caps.map((c) => c.name),
    count: (caps) => caps.length,
    toTools: (caps, resolve) =>
      caps.map((capability) =>
        subagentToTool(
          capability,
          resolve(`@SubAgent "${capability.name}"`, capability.spec.tools),
        ),
      ),
  },
  skill: {
    collect: (inst) => collectSkills(inst),
    toolNames: (caps) => caps.map((c) => c.name),
    count: (caps) => caps.length,
    toTools: (caps, resolve) =>
      caps.map((capability) =>
        skillToTool(capability, resolve(`@Skill "${capability.name}"`, capability.spec.tools)),
      ),
  },
  prompt: {
    collect: (inst) => collectPromptEntries(inst),
    toolNames: (p) => p.tools.map((t) => t.name),
    count: (p) => p.tools.length,
    toTools: (p) => p.tools,
    versions: (p) => p.versions,
  },
};

/**
 * 遍历顺序 = 这张表的键序（收集 / 展开 / 计数都用它）。
 * **从表派生而不是另写一份清单** —— 否则「加了表项忘了加清单」又是一种静默漏项。
 */
export const CAPABILITY_KINDS = Object.keys(KIND_SPEC) as CapabilityKind[];

/**
 * 按类遍历的**唯一**类型擦除点。
 *
 * 为什么必须有这一处：TS 无法把一个循环变量 `kind: CapabilityKind` 与「它对应的那个载荷类型」
 * 关联起来（相关联合，microsoft/TypeScript#30581）—— 泛型在这里推不出来，只能擦除一次。
 * 安全性由三件事共同兜住：① `KIND_SPEC` 是映射类型，**每一行在定义处就逐个收窄**（不是
 * 在这里靠断言）；② `CAPABILITY_KINDS` 从表派生 ⇒ 擦除的覆盖面就是表的覆盖面；
 * ③ `tests/toolkit/capability-slice.test.ts` 用真数据逐类驱动（每类都真的被走到过）。
 */
function specOf(kind: CapabilityKind): CapabilityKindSpec<CapabilityKind> {
  return KIND_SPEC[kind] as CapabilityKindSpec<CapabilityKind>;
}

/** 收集一个 provider 实例上的四类能力（每类都在场，空数组也算在场） */
export function collectCapabilities(inst: object): CollectedByKind {
  // 逐类填满：`{}` 起步 + 下方立刻补齐全部键（键集 = CAPABILITY_KINDS = 表的键集）
  const out = {} as CollectedByKind;
  const sink = out as unknown as Record<CapabilityKind, unknown>;
  for (const kind of CAPABILITY_KINDS) {
    sink[kind] = specOf(kind).collect(inst);
  }
  return out;
}

/** 该 token 的**可用名单**（引用某个不存在的能力名时，报错文案里列的那串） */
export function capabilityToolNames(collected: CollectedByKind): string[] {
  const out: string[] = [];
  for (const kind of CAPABILITY_KINDS) out.push(...specOf(kind).toolNames(collected[kind]));
  return out;
}

/** 该 token 的能力切片（主菜单的一路；调用方再用中间件包装） */
export function buildCapabilitySlice(
  collected: CollectedByKind,
  resolve: ResolveRefTools,
): AgentTool[] {
  const out: AgentTool[] = [];
  for (const kind of CAPABILITY_KINDS) out.push(...specOf(kind).toTools(collected[kind], resolve));
  return out;
}

/** 该 token 上的**能力**条数（孤儿告警口径：能力数，不是编译出来的工具数） */
export function capabilityCount(collected: CollectedByKind): number {
  let n = 0;
  for (const kind of CAPABILITY_KINDS) n += specOf(kind).count(collected[kind]);
  return n;
}

/** 该 token 上的资产版本表（只有 `@Prompt` 有；无可版本化资产时返回 `undefined`） */
export function capabilityVersions(collected: CollectedByKind): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const kind of CAPABILITY_KINDS) {
    const spec = specOf(kind);
    if (!spec.versions) continue; // 本类不参与版本表（缺省，见 CapabilityKindSpec.versions）
    Object.assign(out, spec.versions(collected[kind]));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
