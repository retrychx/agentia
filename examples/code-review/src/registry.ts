import type { Provider } from '@migor/agentia';
import Rubric from './prompts/rubric/index.js';
import Summarize from './skills/summarize/index.js';
import SecurityScan from './subagents/security-scan/index.js';
import CodebaseTools from './tools/index.js';

/** 显式注册表 —— 形状与 `agentia g` 维护的 `src/registry.ts` 完全一致。 */
export const providers: Provider[] = [
  { provide: 'tools', useClass: CodebaseTools },
  { provide: 'rubric', useClass: Rubric },
  { provide: 'security-scan', useClass: SecurityScan },
  { provide: 'summarize', useClass: Summarize },
];
