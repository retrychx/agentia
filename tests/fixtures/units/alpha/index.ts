import { Tool } from '../../../../src/index.js';

export default class Alpha {
  @Tool({ description: 'alpha 工具', schema: { type: 'object', properties: {} } })
  alpha_tool(): string {
    return 'alpha';
  }
}
