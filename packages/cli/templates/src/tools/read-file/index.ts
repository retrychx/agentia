import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Tool } from '@migor/agentia';

/**
 * 读取**工作目录**下的一个文本文件（相对路径）。
 *
 * 它是脚手架自带的第二个能力，作用是把「工作目录」这条线**接通**：
 * `agentia dev` 的面板上有「工作目录」控件，而只有当**某个能力真的消费它**时，
 * 那个控件才有可观测的效果。做法就是这里 —— 根由 DI 注入（`WORKDIR`），
 * 不在代码里写死。见 app.ts 的 providers。
 *
 * 换成别的形态（把 `workdir` 换成某个 API 的 baseUrl、某个数据目录）完全一样：
 * 值从构造器进来，方法里用 `this.root`。
 */
export default class ReadFileTool {
  constructor(private readonly root: string) {
    // discover 自动注册的 provider **没有 deps** —— 如果哪天 app.ts 里那行显式 provider
    // 被删掉，容器会无参构造这个类，root 变成 undefined，工具就会静默地按 cwd 解析。
    // 与其静默，不如在这里响亮报错。
    if (typeof root !== 'string' || root.length === 0) {
      throw new Error(
        'ReadFileTool 需要注入工作目录：请在 src/app.ts 的 providers 里保留 ' +
          "{ provide: 'read-file', useClass: ReadFileTool, deps: ['WORKDIR'] }",
      );
    }
    // ⚠️ **归一化**：调用方给的工作目录可能带尾斜杠（面板输入、dev.config 手写、
    // `.../repo/` 粘进来都很常见），而 `safeResolve` 的越界判定是
    // `abs.startsWith(root + sep)` 这类**字符串前缀**比较 —— root 不归一化时
    // 拼接出来的前缀是 `/a/b//`，判定恒为假 ⇒ **每一次** read_file 都报
    // 「路径越出工作目录」。那不是「误报」，是把工具整个变成坏的（且错误归因误导模型）。
    this.root = resolve(root);
  }

  @Tool({
    description: '读取工作目录下的一个文本文件（给相对路径，如 README.md）',
    schema: {
      type: 'object',
      properties: { rel: { type: 'string', description: '相对工作目录的文件路径' } },
      required: ['rel'],
      additionalProperties: false,
    },
    strict: true,
  })
  // 方法名 = 模型看到的工具名 ⇒ 与其余模板一律 snake_case（doc_reviewer / note_writer …）。
  // 顺带解掉一个坑：这里若叫 readFile，就与上面 import 进来的 readFile 同名 ——
  // 方法体内 `this.readFile(...)` 会变成自我递归，而裸写 `readFile(...)` 读的是 import 的那个。
  async read_file(input: { rel: string }): Promise<string> {
    return readFile(safeResolve(this.root, input.rel), 'utf8');
  }
}

/**
 * 把模型给的路径约束在工作目录内（**越界响亮报错**，错误会作为 is_error 回给模型）。
 *
 * 这条纪律是「可指向任意目录的 agent」活得下去的前提：切目录本身不危险，
 * 危险的是它悄悄跑到工作目录外面去读写。别改成静默截断 / 静默回退。
 *
 * ⚠️ 两端都归一化再比：`root` 由调用方给（可能带尾斜杠），而下面判越界用的是
 * **字符串前缀** —— `resolve(root) + sep` 不归一化时会是 `/a/b//`，于是每一次调用
 * 都误报越界。归一化放在函数内部（不只依赖构造器）：本函数是导出的，调用方可能不止一个。
 */
export function safeResolve(root: string, rel: string): string {
  const base = resolve(root);
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`路径越出工作目录: "${rel}"（工作目录：${base}）`);
  }
  return abs;
}
