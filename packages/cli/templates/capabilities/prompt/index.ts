import { Prompt, asset } from '@migor/agentia';

/** __NAME__ 文本资产能力 */
export default class __CLASS_NAME__ {
  @Prompt({ description: '__NAME__ 文本资产（描述何时该拉取）' })
  __METHOD_NAME__(): string {
    return asset(import.meta.url, './asset.md');
  }
}
