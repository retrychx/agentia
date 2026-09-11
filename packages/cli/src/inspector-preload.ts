/**
 * inspector preload —— 由 dev.ts 用 `NODE_OPTIONS=--import <本文件>` 注入到【子进程】。
 *
 * 为什么需要它：`agentia dev` 用 tsx 起的是子进程，而 trace sink 必须在子进程里注册
 * （框架的 registerDefaultTraceSink 是进程内全局注册表）。CLI 无法在子进程外挂上，
 * 于是用 preload 在应用代码 import 之前抢先注册。
 *
 * 关键：必须从【用户项目】（process.cwd()）解析 @migor/agentia，而不是从 CLI 的
 * 安装位置 —— 否则拿到的是另一个模块实例，注册表不共享，sink 静默失效。
 *
 * 失败一律降级：打印一行告警即可，绝不阻断 dev。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInspectSink } from './inspector-sink.js';

const port = Number(process.env.AGENTIA_INSPECT_PORT || 0);

if (port > 0) {
  try {
    const req = createRequire(join(process.cwd(), 'package.json'));
    const entry = req.resolve('@migor/agentia');
    const mod = (await import(pathToFileURL(entry).href)) as {
      registerDefaultTraceSink?: (sink: unknown) => void;
    };
    if (typeof mod.registerDefaultTraceSink !== 'function') {
      throw new Error('@migor/agentia 未导出 registerDefaultTraceSink（版本过旧？）');
    }
    mod.registerDefaultTraceSink(createInspectSink({ port }));
  } catch (e) {
    console.warn(`[agentia] inspector 未挂载：${(e as Error).message}`);
  }
}
