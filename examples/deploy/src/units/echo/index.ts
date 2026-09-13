import { Tool } from '@migor/agentia';

/** echo 工具单元（示例）：主 agent 可调用，回显输入 */
export default class Echo {
  @Tool({
    description: '回显输入文本（示例工具）',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    strict: true,
  })
  echo(input: { text: string }): string {
    return `echo: ${input.text}`;
  }
}
