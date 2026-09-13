import { SubAgent, asset } from '@migor/agentia';

/**
 * @SubAgent —— **模型自主循环 + 独立裁剪上下文**：内部开 unit span，只把最终结论以
 * tool_result 交回主 agent（隔离报告，中间过程不污染主对话）。
 *
 * 注意：方法体不会被执行 —— 框架只读方法名与装饰器元数据，调用时按 `system` 另起 agent。
 */
export default class Researcher {
  @SubAgent({
    description: '就给定问题做独立调研，给出简明结论（适合需要多步推理、且不希望污染主上下文的子任务）',
    schema: {
      type: 'object',
      properties: { question: { type: 'string', description: '要调研的问题' } },
      required: ['question'],
      additionalProperties: false,
    },
    system: asset(import.meta.url, './system.md'),
  })
  researcher(_input: { question: string }): void {}
}
