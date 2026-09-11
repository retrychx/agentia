import type { SystemParam, SystemTextBlock } from '../engine/types.js';

/**
 * SystemPrompt —— 系统提示拼装 + prompt cache 布局（spec §5）。
 *
 * 缓存是前缀匹配：渲染序 tools → system → messages。
 * 规则：稳定段拼接成一整块并打一个 breakpoint（连带缓存 tools），
 * volatile 段放其后、不带标记（每次重新发送，不污染稳定前缀）。
 * 不要在此插入 Date.now()/随机 id —— 那是隐形 invalidator。
 */
export interface SystemSection {
  name: string;
  text: string;
  /** stable=false 的段不进可缓存前缀，放在 breakpoint 之后 */
  stable?: boolean;
}

export interface SystemPromptOptions {
  /** 提示词版本号；见 `SystemPrompt.version` */
  version?: string;
}

export class SystemPrompt {
  private sections: SystemSection[] = [];

  /**
   * 提示词版本号（D4）：给了它就自动落到 run 根的 `system.version` attribute ——
   * 于是 trace 里能查出「这个结果是哪个版本的提示词产出的」（换 prompt 前后对比
   * 效果、排查回归都靠它）。框架**不做**版本库 / 回滚平台（YAGNI，见 spec §10）：
   * 版本号怎么来（git sha / 语义版本 / 手工）由你决定。
   */
  readonly version?: string;

  constructor(opts: SystemPromptOptions = {}) {
    this.version = opts.version;
  }

  add(section: SystemSection): this;
  add(name: string, text: string, stable?: boolean): this;
  add(nameOrSection: string | SystemSection, text?: string, stable = true): this {
    if (typeof nameOrSection === 'string') {
      this.sections.push({ name: nameOrSection, text: text ?? '', stable });
    } else {
      this.sections.push(nameOrSection);
    }
    return this;
  }

  get stableText(): string {
    return this.sections
      .filter((s) => s.stable !== false)
      .map((s) => s.text)
      .join('\n\n');
  }

  /** cache=true 时给稳定前缀打 ephemeral breakpoint；否则拼成单个纯文本返回 */
  build(opts: { cache?: boolean } = {}): SystemParam {
    const { cache = false } = opts;
    const stable = this.sections.filter((s) => s.stable !== false).map((s) => s.text);
    const volatile = this.sections.filter((s) => s.stable === false).map((s) => s.text);

    if (!cache) {
      return [...stable, ...volatile].filter(Boolean).join('\n\n');
    }

    // 判空必须按**过滤后的文本**：空段（text: ''）不该产出空 text block + breakpoint
    const stableText = stable.filter(Boolean).join('\n\n');
    const blocks: SystemTextBlock[] = [];
    if (stableText) {
      blocks.push({
        type: 'text',
        text: stableText,
        cache_control: { type: 'ephemeral' },
      });
    }
    for (const v of volatile) {
      if (v) blocks.push({ type: 'text', text: v });
    }
    // 无任何段时回 '' 而非 []：engine 对 [] 判真会照发一个空 system
    return blocks.length > 0 ? blocks : '';
  }
}
