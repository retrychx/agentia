import { Prompt, asset } from '@migor/agentia';

/**
 * @Prompt —— 评审 rubric（纯文本资产）：编译成菜单里一个无副作用拉取型工具，
 * 模型评审前先拉它，文本以 tool_result 注入上下文。每次调用现读文件（volatile）。
 */
export default class Rubric {
  @Prompt({ description: '代码评审 rubric：评审维度、严重度与定级标准 —— 开始评审前应先拉取' })
  review_rubric(): string {
    return asset(import.meta.url, './rubric.md');
  }
}
