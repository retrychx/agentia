import type { Provider } from '@migor/agentia';
import type { Workspace } from './workspace.js';
import ListFiles from './tools/list_files/index.js';
import QuarantinePath from './tools/quarantine_path/index.js';
import ReadFile from './tools/read_file/index.js';
import SearchText from './tools/search_text/index.js';
import WriteReport from './tools/write_report/index.js';

/**
 * 显式注册表（`{ provide, useClass, deps }`，deps 按构造器形参顺序注入 token）。
 *
 * 工作区是**构造期就知道的宿主资源**，所以走值 provider + 构造注入：
 * 工具类自己不读 env、不猜路径 —— 它拿到的 `Workspace` 已经带好了两道边界
 * （读面在巡检根之下、写面只有产出目录）。这条边界**没有**交给模型，也不该交给它。
 */
export function buildProviders(ws: Workspace): Provider[] {
  return [
    { provide: 'workspace', useValue: ws },
    { provide: 'list_files', useClass: ListFiles, deps: ['workspace'] },
    { provide: 'read_file', useClass: ReadFile, deps: ['workspace'] },
    { provide: 'search_text', useClass: SearchText, deps: ['workspace'] },
    { provide: 'write_report', useClass: WriteReport, deps: ['workspace'] },
    { provide: 'quarantine_path', useClass: QuarantinePath, deps: ['workspace'] },
  ];
}
