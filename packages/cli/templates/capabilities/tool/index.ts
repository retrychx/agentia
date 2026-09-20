import { Tool } from '@migor/agentia';

/** __NAME__ 工具能力 */
export default class __CLASS_NAME__ {
  @Tool({
    description: '示例工具：回显输入',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    strict: true,
  })
  __METHOD_NAME__(input: { text: string }): string {
    return `echo: ${input.text}`;
  }
}
