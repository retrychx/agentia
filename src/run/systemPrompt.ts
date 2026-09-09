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

export class SystemPrompt {
  private sections: SystemSection[] = [];

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

    const blocks: SystemTextBlock[] = [];
    if (stable.length) {
      blocks.push({
        type: 'text',
        text: stable.join('\n\n'),
        cache_control: { type: 'ephemeral' },
      });
    }
    for (const v of volatile) {
      if (v) blocks.push({ type: 'text', text: v });
    }
    return blocks;
  }
}
