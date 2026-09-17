import { SubAgent, asset } from '@migor/agentia';
import { MODEL } from '../../config.js';

/**
 * @SubAgent —— 安全专项深挖：**模型自主循环 + 裁剪上下文**（它只见自己的 system + 任务 +
 * 自己声明的工具），最终报告以 tool_result 交回主 agent，中间往返不污染主对话。
 *
 * tools 用能力级路径 `'tools/grep_code'`：只借 CodebaseTools 菜单里的 grep_code 一个工具，
 * 而不是整片引用 'tools'（list_files / read_file 它用不上，菜单越小模型越不容易跑偏）。
 *
 * 注意：方法体不会被执行 —— 框架只读方法名与装饰器元数据，调用时按 system 另起独立循环。
 */
export default class SecurityScan {
  @SubAgent({
    description: '对评审对象仓库做安全专项深挖（独立上下文循环；只回结论，中间过程不进主对话）',
    schema: {
      type: 'object',
      properties: { focus: { type: 'string', description: '安全关注点（要扫什么）' } },
      required: ['focus'],
      additionalProperties: false,
    },
    system: asset(import.meta.url, './system.md'),
    tools: ['tools/grep_code'],
    // 显式给模型：子 agent 回合缺省走 engine 默认模型，与本示例的 priceOverrides 口径不一致
    model: MODEL,
  })
  security_scan(_input: { focus: string }): void {}
}
