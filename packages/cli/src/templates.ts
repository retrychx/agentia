/** 命名工具与所有文件模板（零依赖） */

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/** hello-world → HelloWorld */
export function kebabToPascal(name: string): string {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** hello-world → hello_world */
export function kebabToSnake(name: string): string {
  return name.replace(/-/g, '_');
}

export type CapabilityType = 'tool' | 'skill' | 'prompt' | 'subagent';

export const CAPABILITY_TYPES: readonly CapabilityType[] = ['tool', 'skill', 'prompt', 'subagent'];

export function isCapabilityType(value: string): value is CapabilityType {
  return (CAPABILITY_TYPES as readonly string[]).includes(value);
}

// ---------- 目录约定（spec §7：四分类目录，一能力一文件夹，无伞形词） ----------

/**
 * 能力类型 → 分类目录。目录名即「里面装什么」，不再用一个需要图例解释的伞形词：
 * 用户看一眼 `src/tools/weather/index.ts` 就知道它是工具。
 */
export const CAPABILITY_DIRS: Record<CapabilityType, string> = {
  tool: 'src/tools',
  skill: 'src/skills',
  prompt: 'src/prompts',
  subagent: 'src/subagents',
};

/** 全部能力目录（顺序即 discover 的装配顺序） */
export const CAPABILITY_DIR_LIST: readonly string[] = CAPABILITY_TYPES.map(
  (t) => CAPABILITY_DIRS[t],
);

/** 显式注册表位置（`agentia g` / `agentia add` 维护，`agentia doctor` 校验） */
export const REGISTRY_PATH = 'src/registry.ts';

// ---------- 注册表模板 ----------

export const IMPORTS_END_MARKER = '// @agentia:imports-end';
export const ENTRIES_END_MARKER = '// @agentia:entries-end';

/** 空注册表模板（无任何能力条目） */
export function emptyRegistryTemplate(): string {
  return `// Agentia 能力注册表 —— 由 agentia CLI 维护（agentia g 自动更新，也可手工编辑）
// @agentia:imports
${IMPORTS_END_MARKER}
import type { Provider } from '@migor/agentia';

/** 显式装配路线：createApp({ providers, system: ... })（与 discover 目录扫描二选一或混用） */
export const providers: Provider[] = [
  // @agentia:entries
  ${ENTRIES_END_MARKER}
];
`;
}

// ---------- create 命令模板 ----------

export function projectPackageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: 'module',
      scripts: {
        dev: 'tsx src/main.ts',
        build: 'tsc -p tsconfig.json && node scripts/copy-assets.mjs',
        start: 'node dist/main.js',
        typecheck: 'tsc --noEmit -p tsconfig.json',
      },
      dependencies: { '@migor/agentia': '^0.6.1' },
      devDependencies: {
        tsx: '^4.19.0',
        typescript: '^7.0.2',
        '@types/node': '^22.0.0',
      },
    },
    null,
    2,
  )}\n`;
}

export function projectTsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        strict: true,
        // 编译产物落 dist/（npm run build → npm start 跑 dist/main.js）；
        // .md 文本资产由 scripts/copy-assets.mjs 跟随同相对路径拷过去
        // （asset(import.meta.url, './x.md') 按**文件位置**解析，.md 必须跟着 .js 走）
        rootDir: 'src',
        outDir: 'dist',
        // 框架零运行时依赖（不再有厂商 SDK 经传递链把 @types/node 带进编译程序），
        // node 全局类型必须显式声明
        types: ['node'],
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`;
}

export function mainTs(name: string): string {
  return `import { createApp, loadEnvFile, SystemPrompt } from '@migor/agentia';

// 读同目录的 .env（key 写文件里即可，不必每次 export）。框架**不自动**读 .env ——
// 读哪个文件、什么时候读由这里决定；已存在的真实环境变量优先，不会被文件覆盖。
// 想换路径/顺序：loadEnvFile({ path: '.env.local' }) 或直接删掉这一行改用自己的加载器。
loadEnvFile();

const app = await createApp({
  name: '${name}',
  discover: [${CAPABILITY_DIR_LIST.map((p) => `'${p}'`).join(', ')}], // 四分类目录，顺序即装配顺序
  system: new SystemPrompt().add('role', '你是 ${name} 的主 agent，按任务自主调度菜单里的能力。', true),
});

const { result } = await app.run(
  [{ role: 'user', content: process.argv[2] ?? '介绍一下你自己' }],
);

// 注意：run 失败**不会抛**（硬失败被记进 result.error 与 trace 后正常返回）—— 不显式检查就会
// 「打印一行空白 + 退出 0」，让首次运行（比如忘了配 ANTHROPIC_API_KEY）看起来像成功。
if (result.error) {
  console.error(\`run 失败（stopReason=\${result.stopReason}）：\${result.error.message}\`);
  console.error('提示：模型调用读 ANTHROPIC_API_KEY —— 填进 .env（首行 loadEnvFile() 会读）或 export 均可；');
  console.error('      换端点 / 注入自定义 client 见项目内 AGENTS.md。');
  process.exitCode = 1;
}
if (result.finalText) console.log(result.finalText);
`;
}

export function projectReadme(name: string): string {
  return `# ${name}

基于 [Agentia](https://github.com/retrychx/agentia) 框架的 agent 应用。

## 目录约定

四分类目录，一能力一文件夹，每个能力是一个 default export 的类，用装饰器声明：

- \`src/tools/<name>/\` —— \`@Tool\` 工具：主 agent 可调用（input → value）
- \`src/skills/<name>/\` —— \`@Skill\` 技能：方法体内通过 \`ctx.llm()\` 调 LLM
- \`src/subagents/<name>/\` —— \`@SubAgent\` 子代理：按 system 角色设定独立跑一轮
- \`src/prompts/<name>/\` —— \`@Prompt\` 文本资产：.md 文件，按需拉取进上下文

目录名就是类型，不用记别名。

## 两条装配路线

1. **目录扫描**：\`createApp({ discover: [...] })\` 启动期按给定顺序扫各目录下的 \`<name>/index.ts\`，default export 为类时以文件夹名为 DI token 注册（见 \`src/main.ts\`）。
2. **显式装配**：\`createApp({ providers, system })\`，providers 来自 \`src/registry.ts\` 注册表（由 \`agentia g\` 自动维护，也可手工编辑）。

两者二选一或混用。

## 生成能力

\`\`\`bash
agentia g tool my-tool        # → src/tools/my-tool/
agentia g skill my-skill      # → src/skills/my-skill/
agentia g prompt my-prompt    # → src/prompts/my-prompt/（含 asset.md）
agentia g subagent my-agent   # → src/subagents/my-agent/（含 system.md）
\`\`\`

生成的能力自动登记到 \`src/registry.ts\`。

## 运行

需要 Anthropic API key —— 填进脚手架已生成的 \`.env\` 即可（本文件在 \`.gitignore\` 里）：

\`\`\`bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
\`\`\`

\`\`\`bash
npm run dev -- "你的问题"
\`\`\`

## 构建与生产运行

\`\`\`bash
npm run build   # tsc → dist/ + .md 文本资产跟随拷贝（asset() 按文件位置解析，必须跟着 .js 走）
npm start -- "你的问题"   # 跑编译产物 dist/main.js（部署/Docker 用这条）
\`\`\`

也可以用环境变量（适合 CI / 容器）——**真实环境变量优先，不会被 \`.env\` 覆盖**：

\`\`\`bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev -- "你的问题"
\`\`\`

\`.env\` 由 \`src/main.ts\` 首行的 \`loadEnvFile()\` 读取。框架**不会自动读**它 ——
读哪个文件、什么时候读由你的启动代码决定（这样「换目录跑」不会悄悄改变行为）。
`;
}

export function projectGitignore(): string {
  return `node_modules
dist

# 本地环境变量（可能含 key）—— 绝不提交
.env
.env.local
`;
}

/** 脚手架生成的 .env：填上就能跑，已进 .gitignore */
export function projectDotEnv(): string {
  return `# 模型 API key —— 填上后 npm run dev / npm start 直接可用
# 本文件已被 .gitignore 忽略：不要提交，也不要把 key 写进 README / AGENTS.md
ANTHROPIC_API_KEY=
`;
}

/** 随脚手架提交的 .env.example：进版本库的变量清单，值一律留空 */
export function projectDotEnvExample(): string {
  return `# 复制成 .env 再填值（.env 已 gitignore，不要提交）
ANTHROPIC_API_KEY=

# 可选
# ANTHROPIC_BASE_URL=https://api.anthropic.com
# AGENTIA_MODEL=claude-opus-5
`;
}

/** 脚手架的 scripts/copy-assets.mjs：把 src 下的 .md 文本资产拷进 dist/（同相对路径） */
export function copyAssetsMjs(): string {
  return `// 把能力文件夹里的 .md 文本资产拷进 dist/（与编译产物同相对路径）。
// asset(import.meta.url, './x.md') 按**文件位置**解析，所以 .md 必须跟着 .js 走。
import { cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(here, '..', 'src');
const outDir = join(here, '..', 'dist');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

let n = 0;
for (const f of walk(srcDir)) {
  cpSync(f, join(outDir, f.slice(srcDir.length + 1)));
  n++;
}
console.log(\`[copy-assets] \${n} 个 .md 资产 → dist/\`);
`;
}

// ---------- g 命令能力模板 ----------

export function toolIndexTs(name: string): string {
  const cls = kebabToPascal(name);
  const method = kebabToSnake(name);
  return `import { Tool } from '@migor/agentia';

/** ${name} 工具能力 */
export default class ${cls} {
  @Tool({
    description: '示例工具：回显输入',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    strict: true,
  })
  ${method}(input: { text: string }): string {
    return \`echo: \${input.text}\`;
  }
}
`;
}

export function promptIndexTs(name: string): string {
  const cls = kebabToPascal(name);
  const method = kebabToSnake(name);
  return `import { Prompt, asset } from '@migor/agentia';

/** ${name} 文本资产能力 */
export default class ${cls} {
  @Prompt({ description: '${name} 文本资产（描述何时该拉取）' })
  ${method}(): string {
    return asset(import.meta.url, './asset.md');
  }
}
`;
}

export function promptAssetMd(name: string): string {
  return `# ${name}

在此编写提示文本资产（按需被主 agent 拉取进上下文）。
`;
}

export function subagentIndexTs(name: string): string {
  const cls = kebabToPascal(name);
  const method = kebabToSnake(name);
  return `import { SubAgent, asset } from '@migor/agentia';

/** ${name} 子代理能力 */
export default class ${cls} {
  @SubAgent({
    description: '示例子代理：按 system.md 的角色设定独立处理任务',
    schema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
      additionalProperties: false,
    },
    system: asset(import.meta.url, './system.md'),
  })
  // 方法体不会执行：@SubAgent 只读取方法名与装饰器元数据，调用时由框架按 system 另起 agent 执行
  ${method}(_input: { task: string }): void {}
}
`;
}

export function subagentSystemMd(name: string): string {
  return `# ${name}

在此编写子代理的角色描述（作为其子 agent 的 system prompt）。
`;
}

export function skillIndexTs(name: string): string {
  const cls = kebabToPascal(name);
  const method = kebabToSnake(name);
  return `import { Skill } from '@migor/agentia';
import type { SkillContext } from '@migor/agentia';

/** ${name} 技能能力 */
export default class ${cls} {
  @Skill({
    description: '示例技能：就给定主题调用 LLM 产出要点',
    schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
      additionalProperties: false,
    },
  })
  async ${method}(input: { topic: string }, ctx: SkillContext): Promise<string> {
    const r = await ctx.llm({ prompt: \`就「\${input.topic}」给出三个要点\` });
    return r.text;
  }
}
`;
}
