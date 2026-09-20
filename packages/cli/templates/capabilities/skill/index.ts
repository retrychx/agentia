import { Skill } from '@migor/agentia';
import type { SkillContext } from '@migor/agentia';

/** __NAME__ 技能能力 */
export default class __CLASS_NAME__ {
  @Skill({
    description: '示例技能：就给定主题调用 LLM 产出要点',
    schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
      additionalProperties: false,
    },
  })
  async __METHOD_NAME__(input: { topic: string }, ctx: SkillContext): Promise<string> {
    const r = await ctx.llm({ prompt: `就「${input.topic}」给出三个要点` });
    return r.text;
  }
}
