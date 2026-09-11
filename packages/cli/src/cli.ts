#!/usr/bin/env node
/** agentia CLI 入口：手写参数解析 + 命令分发（零依赖） */
import { createProject } from './create.js';
import { generateUnit } from './generate.js';
import { isUnitType, isValidName, UNIT_TYPES } from './templates.js';
import { RegistryError } from './registry.js';
import { devServer } from './dev.js';
import { doctor } from './doctor.js';
import { addPackage } from './add.js';

const USAGE = `agentia —— Agentia 框架命令行工具

用法：
  agentia create <name> [--dir <parent>]   创建项目脚手架（目录 <parent|当前目录>/<name>/）
  agentia g <type> <name>                  在当前目录生成单元（别名：generate）
                                           type: ${UNIT_TYPES.join(' | ')}
  agentia dev                              启动开发模式（tsx watch 热重载 + 本地 inspector 面板）
  agentia doctor                           装配体检（未登记/悬空单板/命名规范/重复条目）
  agentia add <pkg>                        安装第三方单元包并登记到 units.ts
  agentia --help                           显示本帮助

name 规则：小写字母开头的小写 kebab-case（如 hello、doc-reviewer）
`;

function fail(message: string): number {
  console.error(`错误：${message}`);
  process.exitCode = 1;
  return 1;
}

function checkName(name: string | undefined): name is string {
  if (name === undefined) return false;
  return isValidName(name);
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  if (command === 'create') {
    const name = rest[0];
    let parent: string | undefined;
    for (let i = 1; i < rest.length; i += 1) {
      if (rest[i] === '--dir') {
        parent = rest[i + 1];
        if (parent === undefined) return fail('--dir 需要一个目录参数');
        i += 1;
      } else {
        return fail(`未知参数：${rest[i]}`);
      }
    }
    if (name === undefined) return fail('缺少项目名，用法：agentia create <name> [--dir <parent>]');
    if (!checkName(name)) {
      return fail(`非法项目名「${name}」：需匹配小写 kebab-case（如 my-app）`);
    }
    return createProject(name, parent);
  }

  if (command === 'g' || command === 'generate') {
    const [type, name, ...extra] = rest;
    if (type === undefined || name === undefined || extra.length > 0) {
      return fail('用法：agentia g <type> <name>（type: tool | skill | prompt | subagent）');
    }
    if (!isUnitType(type)) {
      return fail(`未知单元类型「${type}」，可选：${UNIT_TYPES.join(' | ')}`);
    }
    if (!checkName(name)) {
      return fail(`非法单元名「${name}」：需匹配小写 kebab-case（如 doc-reviewer）`);
    }
    try {
      return generateUnit(type, name);
    } catch (err) {
      if (err instanceof RegistryError) return fail(err.message);
      throw err;
    }
  }

  if (command === 'dev') {
    if (rest.length > 0) return fail(`未知参数：${rest[0]}`);
    return devServer();
  }

  if (command === 'doctor') {
    if (rest.length > 0) return fail(`未知参数：${rest[0]}`);
    return doctor();
  }

  if (command === 'add') {
    const [pkg, ...extra] = rest;
    if (pkg === undefined || extra.length > 0) {
      return fail('用法：agentia add <pkg>（npm 包名或本地包路径）');
    }
    try {
      return addPackage(pkg);
    } catch (err) {
      if (err instanceof RegistryError) return fail(err.message);
      throw err;
    }
  }

  console.error(`错误：未知命令「${command}」\n`);
  console.error(USAGE);
  process.exitCode = 1;
  return 1;
}

process.exitCode = main(process.argv.slice(2));
