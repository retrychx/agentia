/*
 * 架构守卫 —— 「传输层适配器抛的错误必须能被 classifyError 分类」的可执行版本。
 *
 * 为什么需要它（真实事故，见 docs/spec.md §10 2026-09-18）：
 * `engine/errors.ts` 的错误分类是**鸭子类型**，只认数据属性（数值 `status` / `cause` /
 * errno `code`）。而 `openai.ts` 曾一律抛裸 `new Error("OpenAI 请求失败 429: …")` ——
 * status 只在**文案**里、没有结构化字段，于是：
 *   classifyError → { type:'unknown', retryable:false }
 *   → resolveRetry 的缺省 isRetryable 判否 → 引擎层那 3 次重试**一次都不会发生**，
 * 且 trace 把它记成 unknown 而非 rate_limit。DeepSeek 这类兼容端点吃一个 429 就整轮失败。
 *
 * `layering.test.ts` 守的是「依赖方向」，本文件守的是「**错误形状**」—— 同一类
 * 「约定只写在文档里、没有门禁」的缺口。判定刻意做窄：
 * 只有「文案里出现 HTTP 状态码、却抛裸 Error」才算违规；构造期配置校验（程序员错误，
 * 本就不该重试）一律豁免 —— 宁可窄，不要误报（误报的门禁最终会被人 ignore 掉）。
 *
 * ⚠️ 无法被本守卫覆盖的：抛 `Error` 子类但**不带数值 status** 的情况（如
 * `AbstractVendorError extends Error` 无 status）；以及非 integrations 层的传输代码。
 * 那两类要靠 errors.test.ts 的行为测试（假端点 → classifyError 判可重试）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件在 tests/architecture/ —— 回退两层才是仓库根
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(repoRoot, 'src');

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

/**
 * 丢掉**整行**注释（`//` 开头 / 块注释的 `*` 行），而**不是**「截到 `//` 为止」。
 *
 * 为什么不能截（2026-09-18 修）：`//` 会出现在**字符串/模板串里**，本仓库最常见的形态
 * 就是 URL（`http://localhost:4318`）。截断会把该行的闭合 `)` 与反引号一起切掉，
 * 于是 `bareErrorThrows` 的括号配平一路吃到文件末尾 —— **那一行之后的每一处抛错都再也
 * 扫不到，且不报错**。实测：`metrics.ts` 里
 * `export:'otlp' 必须给 endpoint（如 http://localhost:4318）` 那一行之后，
 * 8 处裸抛错只剩 2 处可见，其中包括 `OTLP metrics 导出失败: HTTP ${res.status}`
 * —— 而后者正是本守卫存在的理由（同 `otlp.ts` 被本守卫抓到的那次）。
 *
 * 改成「整行丢弃」两头都对：块注释的说明行（`*` / `//` 开头）不再误报，
 * 字符串里的 `//` 也不再破坏扫描。
 */
function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

/** 文案里出现 HTTP 状态码的痕迹（`HTTP 429` / `${res.status}` / `状态码`） */
const HAS_STATUS_IN_MESSAGE = /\bHTTP\b|\bres\.status\b|\$\{res\.status\}|状态码/;

/**
 * 构造期配置校验的文案特征 —— 程序员错误，不重试，**豁免**。
 * 与 `metrics.ts` 里 `metricsSink: xxx 必须为…` 那一族同形。
 */
const IS_CONFIG_VALIDATION = /必须|只支持|收到|非法|不得|不支持|未注册|只能/;

/** 裸 `throw new Error(...)`：捕获到匹配的 `)` 为止（含嵌套括号与模板串） */
function bareErrorThrows(text: string): string[] {
  const out: string[] = [];
  const marker = 'throw new Error(';
  let i = 0;
  for (;;) {
    const at = text.indexOf(marker, i);
    if (at === -1) break;
    let depth = 1;
    let j = at + marker.length;
    while (j < text.length && depth > 0) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
      j++;
    }
    out.push(text.slice(at, j));
    i = j;
  }
  return out;
}

/** 该 throw 是否违规：带 HTTP 状态痕迹、且不是配置校验 */
function isTransportViolation(thrown: string): boolean {
  return HAS_STATUS_IN_MESSAGE.test(thrown) && !IS_CONFIG_VALIDATION.test(thrown);
}

/** 扫一个目录，返回违规的 `相对路径: 抛错片段` */
function findViolations(dir: string): string[] {
  const bad: string[] = [];
  for (const p of walkTs(dir)) {
    const text = stripCommentLines(readFileSync(p, 'utf8'));
    for (const thrown of bareErrorThrows(text)) {
      if (isTransportViolation(thrown)) {
        bad.push(`${relative(repoRoot, p)} → ${thrown.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
  }
  return bad;
}

test('integrations 的传输失败必须带结构化 status（否则重试层静默失效）', () => {
  const bad = findViolations(join(SRC, 'integrations'));
  assert.deepEqual(
    bad,
    [],
    '这些抛错把 HTTP 状态写进了文案、对象却没有数值 status —— classifyError 会判 unknown、' +
      `retryable:false，引擎层重试一次都不会发生：\n${bad.join('\n')}\n` +
      '修法：抛带 `readonly status: number` 的错误类（见 anthropic.ts 的 AnthropicApiError / ' +
      'openai.ts 的 OpenAICompatApiError）。构造期配置校验请用「必须 / 只支持 / 收到」等文案豁免。',
  );
});

/**
 * 反向守卫：`*ApiError` 这个命名是「可被 classifyError 分类」的约定形状 ——
 * 名字对了却没有数值 status，等于把「结构性保证」退化成一个好听的名字。
 * 这条也顺便拦住「有人把 status 改成 string / 删掉」的回归。
 */
const API_ERROR_CLASS_DECL = /export class (\w*ApiError) extends Error \{\n([\s\S]*?)\n\}/g;

test('每个 `*ApiError` 类都必须暴露数值 status（命名即承诺）', () => {
  const bad: string[] = [];
  for (const p of walkTs(join(SRC, 'integrations'))) {
    const text = stripCommentLines(readFileSync(p, 'utf8'));
    for (const m of text.matchAll(API_ERROR_CLASS_DECL)) {
      const [, name, body] = m;
      if (!/readonly status:\s*number/.test(body)) {
        bad.push(`${relative(repoRoot, p)} → class ${name} 缺 \`readonly status: number\``);
      }
    }
  }
  assert.deepEqual(bad, [], `按约定命名的传输错误类必须带数值 status：\n${bad.join('\n')}`);
});

/**
 * 解析器自身的回归钉（合成样本）：守卫的核心是那两行判定，任何一边退化都会
 * **真空变绿**（扫不到违规 → 全绿），所以用合成样本把「抓得到 / 不误伤」两侧都钉住。
 */
test('判定器抓得到违规、且不误伤配置校验（合成样本）', () => {
  // 样本里就必须有字面 `${...}`：用字符串拼接避开 noTemplateCurlyInString，同时保持可读
  const S = '${';
  const transport = `throw new Error(\`OTLP 导出失败: HTTP ${S}res.status} ${S}text}\`)`;
  const config = `throw new Error(\`metricsSink: export:'otlp' 必须给 endpoint\`)`;
  const statusless = 'throw new Error("请求失败")';

  assert.equal(isTransportViolation(transport), true, '带 HTTP 状态 + 裸 Error 必须判违规');
  assert.equal(isTransportViolation(config), false, '构造期配置校验必须豁免（文案含「必须」）');
  assert.equal(isTransportViolation(statusless), false, '没有状态痕迹的普通抛错不该被误伤');

  // 整段扫描器要真的产出（防空转）
  const found = findViolations(join(SRC, 'integrations'));
  assert.ok(Array.isArray(found), 'findViolations 必须返回数组');
});

/**
 * 覆盖计数下限（同 layering.test.ts 的「防真空变绿」护栏）：
 * 现在 integrations 里裸 `throw new Error` 有十几处，若解析器退化成返回空，
 * 上面的断言会 vacuously 全绿。跌破下限说明「解析器漏了某种写法」而非「代码没抛错了」。
 */
test('解析器真的吃到了足够多的裸抛错（防真空变绿护栏）', () => {
  let count = 0;
  for (const p of walkTs(join(SRC, 'integrations'))) {
    count += bareErrorThrows(stripCommentLines(readFileSync(p, 'utf8'))).length;
  }
  assert.ok(
    count >= 8,
    `只解析到 ${count} 处裸 \`throw new Error\` —— 解析器大概率漏了某种写法（本守卫在空转）`,
  );
});

/**
 * 回归钉（2026-09-18）：注释剥离**不得**被字符串里的 `//` 破坏。
 *
 * 病灶：旧实现把每行「截到 `//` 为止」，而 `//` 会出现在字符串/模板串里（最典型是 URL）。
 * 截断会把该行的闭合 `)` 与反引号一起切掉，于是 `bareErrorThrows` 的括号配平一路吃到文件
 * 末尾 —— **那一行之后的每一处抛错都再也扫不到，且不报错**。
 * 实测 `src/integrations/metrics.ts`：8 处裸抛错只剩 2 处可见，被吞掉的正好包括
 * `OTLP metrics 导出失败: HTTP ${res.status}`（本守卫存在的理由）。
 */
test('注释剥离不被打断：字符串里的 // 之后仍要扫得到（回归）', () => {
  const S = '${';
  const src = [
    "  const url = 'http://localhost:4318';",
    '  throw new Error(`OTLP metrics 导出失败: HTTP ' + S + 'res.status}`);',
  ].join('\n');

  const found = bareErrorThrows(stripCommentLines(src));
  assert.equal(found.length, 1, 'URL 行之后的抛错必须仍被扫到（旧实现在这里会漏）');
  assert.equal(isTransportViolation(found[0]), true, '而且要被判为违规');
});
