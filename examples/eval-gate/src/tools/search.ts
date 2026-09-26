import { Tool } from '@migor/agentia';

/**
 * 一个确定性能力（示例用）—— 不联网、结果可预期，于是 eval 的断言稳定。
 *
 * `query === 'BOOM'` 时抛错：用来演示「工具失败不中断 run」这条断言
 * （引擎把失败记成 `is_error` 的 tool_result，run 继续）。
 */
export default class Search {
  @Tool({
    description: '在本地语料里检索（示例：返回固定三段）',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索词' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  })
  search(input: { query: string }): string {
    if (input.query === 'BOOM') throw new Error('检索后端炸了（示例）');
    return `命中 3 段：${input.query} …`;
  }
}
