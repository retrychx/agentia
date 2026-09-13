import { Skill } from '@migor/agentia';
import type { SkillContext } from '@migor/agentia';

/**
 * @Skill —— **代码控制的流程**：方法体是确定性脚本，「要不要调模型 / 调几次」写死在代码里。
 *
 * 对比 @SubAgent（模型自主循环 + 独立裁剪上下文）：这里中间结果不外泄，方法返回值即产物，
 * 以 tool_result 交回主 agent。
 */
export default class OutlineWriter {
  @Skill({
    description: '给定主题产出三段式提纲（一次受限模型调用，流程固定）',
    schema: {
      type: 'object',
      properties: { topic: { type: 'string', description: '提纲主题' } },
      required: ['topic'],
      additionalProperties: false,
    },
  })
  async outline_writer(input: { topic: string }, ctx: SkillContext): Promise<string> {
    // ctx.llm = 受限子运行（复用 runAgentScoped，不自开 run 根），在 skill 自己的 unit span 下记账
    const r = await ctx.llm({ prompt: `为主题「${input.topic}」写三段式提纲，每段一行，不要多余解释。` });
    return r.text;
  }
}
