import { Skill } from '@migor/agentia';
import type { SkillContext } from '@migor/agentia';
import { MODEL } from '../../config.js';

/**
 * @Skill —— 汇总定级：**代码控制的流程**（「调一次模型、拿文本回来」写死在方法体里）。
 * 对比 @SubAgent（模型自主决定走几步）：这里只在显式 ctx.llm() 时发生模型调用，
 * 受限子运行在 skill 自己的 capability span 下记账。
 */
export default class Summarize {
  @Skill({
    description: '把各渠道评审发现汇总成整体定级结论（一次受限模型调用，流程固定）',
    schema: {
      type: 'object',
      properties: {
        findings: { type: 'string', description: '已收集的评审发现（清单文本或 JSON）' },
      },
      required: ['findings'],
      additionalProperties: false,
    },
    // 同 subagent：显式给模型，让 ctx.llm 回合也走本示例的定价口径
    model: MODEL,
  })
  async summarize(input: { findings: string }, ctx: SkillContext): Promise<string> {
    const r = await ctx.llm({
      system: '你是评审结论撰写器：只输出整体风险定级（high/medium/low）与一段不超过三行的结论。',
      prompt: `根据以下评审发现给出整体定级与结论：\n${input.findings}`,
    });
    return r.text;
  }
}
