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

export type UnitType = 'tool' | 'skill' | 'prompt' | 'subagent';

export const UNIT_TYPES: readonly UnitType[] = ['tool', 'skill', 'prompt', 'subagent'];

export function isUnitType(value: string): value is UnitType {
  return (UNIT_TYPES as readonly string[]).includes(value);
}

// ---------- units.ts 注册表模板 ----------

export const IMPORTS_END_MARKER = '// @agentia:imports-end';
export const ENTRIES_END_MARKER = '// @agentia:entries-end';

/** 空注册表模板（无任何单元条目） */
export function emptyRegistryTemplate(): string {
  return `// Agentia 单元注册表 —— 由 agentia CLI 维护（agentia g 自动更新，也可手工编辑）
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
        typecheck: 'tsc --noEmit -p tsconfig.json',
      },
      dependencies: { '@migor/agentia': '^0.2.0' },
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
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ['src', 'units.ts'],
    },
    null,
    2,
  )}\n`;
}

export function mainTs(name: string): string {
  return `import { createApp, SystemPrompt } from '@migor/agentia';

const app = await createApp({
  name: '${name}',
  discover: 'units', // 目录约定：units/<name>/ 一单元一文件夹，启动期扫描装配
  system: new SystemPrompt().add('role', '你是 ${name} 的主 agent，按任务自主调度菜单里的单元。', true),
});

const { result } = await app.run(
  [{ role: 'user', content: process.argv[2] ?? '介绍一下你自己' }],
);
console.log(result.finalText);
`;
}

export function projectReadme(name: string): string {
  return `# ${name}

基于 [Agentia](https://github.com/) 框架的 agent 应用。

## 目录约定

\`units/<name>/\` 一单元一文件夹，每个单元是一个 default export 的类，用装饰器声明能力：

- \`@Tool\` 工具：主 agent 可调用（input → value）
- \`@Skill\` 技能：方法体内通过 \`ctx.llm()\` 调 LLM
- \`@SubAgent\` 子代理：按 system 角色设定独立跑一轮
- \`@Prompt\` 文本资产：.md 文件，按需拉取进上下文

## 两条装配路线

1. **目录扫描**：\`createApp({ discover: 'units' })\` 启动期扫描 \`units/*/index.ts\`，default export 为类时以文件夹名为 DI token 注册（见 \`src/main.ts\`）。
2. **显式装配**：\`createApp({ providers, system })\`，providers 来自 \`units.ts\` 注册表（由 \`agentia g\` 自动维护，也可手工编辑）。

两者二选一或混用。

## 生成单元

\`\`\`bash
agentia g tool my-tool        # 工具
agentia g skill my-skill      # 技能
agentia g prompt my-prompt    # 文本资产（含 asset.md）
agentia g subagent my-agent   # 子代理（含 system.md）
\`\`\`

生成的单元在 \`units/<name>/\`，并自动登记到 \`units.ts\`。

## 运行

需要 Anthropic API key：

\`\`\`bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev -- "你的问题"
\`\`\`
`;
}

export function projectGitignore(): string {
  return `node_modules
dist
`;
}

// ---------- g 命令单元模板 ----------

export function toolIndexTs(name: string): string {
  const cls = kebabToPascal(name);
  const method = kebabToSnake(name);
  return `import { Tool } from '@migor/agentia';

/** ${name} 工具单元 */
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

/** ${name} 文本资产单元 */
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

/** ${name} 子代理单元 */
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

/** ${name} 技能单元 */
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
