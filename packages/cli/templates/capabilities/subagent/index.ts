import { SubAgent, asset } from '@migor/agentia';

/** __NAME__ 子代理能力 */
export default class __CLASS_NAME__ {
  @SubAgent({
    description: '示例子代理：按 system.md 的角色设定独立处理任务',
    schema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
      additionalProperties: false,
    },
    system: asset(import.meta.url, './system.md'),
  })
  // 方法体不会执行：@SubAgent 只读取方法名与装饰器元数据，调用时由框架按 system 另起 agent 执行
  __METHOD_NAME__(_input: { task: string }): void {}
}
