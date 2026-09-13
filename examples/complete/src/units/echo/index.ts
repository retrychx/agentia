import { Tool } from '@migor/agentia';

/** @Tool —— 主 agent 可调用的确定性能力（入参 = 模型按 schema 解析的结构化 input） */
export default class Echo {
  @Tool({
    description: '回显输入文本（示例工具）',
    schema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
      additionalProperties: false,
    },
    strict: true,
  })
  echo(input: { text: string }): string {
    return `echo: ${input.text}`;
  }
}
