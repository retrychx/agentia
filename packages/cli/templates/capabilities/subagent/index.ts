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
    // ⚠️ 写成**函数形态**（`() => asset(...)`）不是风格问题：值形态在**类定义时**求值，
    // 于是 system.md 的改动要重启进程才生效（而 `.md` 不在 tsx 的 import 图里，
    // 连「改了要重启」都不会提示你 —— 是个静默失效）。函数形态每次调用重新读文件。
    // 同一条通则管着工具的根目录：**在模块加载期读 = 冻；在调用期读 = 热**。
    system: () => asset(import.meta.url, './system.md'),
  })
  // 方法体不会执行：@SubAgent 只读取方法名与装饰器元数据，调用时由框架按 system 另起 agent 执行
  __METHOD_NAME__(_input: { task: string }): void {}
}
