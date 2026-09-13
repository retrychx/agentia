import { Prompt, asset } from '@migor/agentia';

/**
 * @Prompt —— **纯文本资产**：编译成菜单里一个无副作用拉取型工具，模型判定需要时调用，
 * 文本以 tool_result 注入上下文（这就是「被选中」的唯一机制）。
 *
 * 每次调用现读文件（volatile），适合会随仓库改动的内容。
 */
export default class HouseStyle {
  @Prompt({ description: '公司文风规范 —— 写面向用户的文案前应先拉取' })
  house_style(): string {
    return asset(import.meta.url, './asset.md');
  }
}
