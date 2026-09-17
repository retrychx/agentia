/**
 * 离线确定性 demo（npm run demo）—— 用框架公共面 `scriptedClient` 把模型回合写成剧本，
 * 零 API key、零网络：任何人 clone 下来跑出的菜单 / trace / 报告 / token / 成本完全一致
 * （trace 里的时间戳除外）。真模型跑法见 src/main.ts（npm start）。
 *
 * 剧本即「一个理想模型会怎么走这轮评审」：拉 rubric → 列文件 → 通读 → 委派安全子 agent
 * → 汇总定级 → 提交结构化报告。scriptedClient 按**消费顺序**依次出响应（子 agent / skill
 * 的回合也在同一队列里），所以它同时是「编排路径回归测试」：能力改坏一个，剧本就对不上号。
 */
import { scriptedClient } from '@migor/agentia';
import type { ScriptedStep } from '@migor/agentia';
import { MODEL } from './config.js';
import { runReview } from './review.js';

const usage = (inputTokens: number, outputTokens: number) => ({
  input_tokens: inputTokens,
  output_tokens: outputTokens,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

let seq = 0;
/** 一个「调工具」回合（可多 tool_use 并行） */
function toolTurn(
  inputTokens: number,
  outputTokens: number,
  calls: Array<{ name: string; input: unknown }>,
) {
  const id = ++seq;
  return {
    id: `m${id}`,
    model: MODEL,
    stop_reason: 'tool_use' as const,
    usage: usage(inputTokens, outputTokens),
    content: calls.map((c, i) => ({ type: 'tool_use', id: `tu${id}_${i}`, ...c })),
  };
}
/** 一个「纯文本收尾」回合 */
function textTurn(inputTokens: number, outputTokens: number, text: string) {
  const id = ++seq;
  return {
    id: `m${id}`,
    model: MODEL,
    stop_reason: 'end_turn' as const,
    usage: usage(inputTokens, outputTokens),
    content: [{ type: 'text', text }],
  };
}

const FINDINGS = [
  {
    file: 'src/auth.ts',
    line: 6,
    severity: 'critical',
    title: '硬编码管理员口令',
    detail:
      'ADMIN_PASSWORD 明文写在源码里并进版本库，无法按环境轮换，泄露即失守。应改为从密钥服务/env 注入。',
  },
  {
    file: 'src/auth.ts',
    line: 13,
    severity: 'major',
    title: '口令用 MD5 无盐哈希存储',
    detail: 'MD5 彩虹表秒破。口令存储应使用 argon2/bcrypt 并加盐。',
  },
  {
    file: 'src/upload.ts',
    line: 11,
    severity: 'critical',
    title: '上传文件名未校验，存在路径穿越',
    detail:
      'name 直接拼进路径，传 "../../etc/cron.d/pwn" 可越出上传目录写任意文件。应校验 basename 并约束在 UPLOAD_DIR 内。',
  },
  {
    file: 'src/counter.ts',
    line: 9,
    severity: 'major',
    title: 'withdraw 存在 check-then-act 竞态',
    detail:
      '余额检查与扣减之间隔着 await，并发请求可双双通过检查把余额扣成负数（双花）。应把判断+扣减放进同一事务/锁。',
  },
  {
    file: 'src/config.ts',
    line: 6,
    severity: 'major',
    title: '上游连接关闭 TLS 证书校验',
    detail: 'rejectUnauthorized:false 使中间人攻击面全开，等价于明文传输。应开启校验并固定证书链。',
  },
];

/** 8 步剧本：主循环 5 回合 + 安全子 agent 2 回合 + summarize 的受限模型调用 1 次 */
const SCRIPT: ScriptedStep[] = [
  // 1) 主 agent：拉评审 rubric + 列文件清单（同回合并行）
  toolTurn(1500, 90, [
    { name: 'review_rubric', input: {} },
    { name: 'list_files', input: {} },
  ]),
  // 2) 主 agent：通读四个源文件（同回合并行）
  toolTurn(3200, 70, [
    { name: 'read_file', input: { path: 'src/auth.ts' } },
    { name: 'read_file', input: { path: 'src/upload.ts' } },
    { name: 'read_file', input: { path: 'src/counter.ts' } },
    { name: 'read_file', input: { path: 'src/config.ts' } },
  ]),
  // 3) 主 agent：委派安全专项深挖（→ 子 agent 独立循环，见 4、5 两步）
  toolTurn(4100, 110, [
    { name: 'security_scan', input: { focus: '硬编码凭据 / 弱哈希 / 路径穿越 / 传输安全' } },
  ]),
  // 4) security_scan 子 agent：用借来的 grep_code 按模式扫
  toolTurn(1300, 60, [
    { name: 'grep_code', input: { pattern: 'password|secret|token|md5|rejectUnauthorized' } },
  ]),
  // 5) security_scan 子 agent：收尾报告（隔离报告，以 tool_result 回主 agent）
  textTurn(
    1800,
    240,
    '安全发现：\n' +
      '- src/auth.ts:6 — 硬编码管理员口令 — 改从密钥服务注入\n' +
      '- src/auth.ts:13 — MD5 无盐哈希 — 换 argon2/bcrypt\n' +
      '- src/upload.ts:11 — 文件名未校验可路径穿越 — 校验 basename 并约束目录\n' +
      '- src/config.ts:6 — 关闭 TLS 证书校验 — 开启并固定证书链\n' +
      '总体：存在两个可直接利用的 critical 项，安全状况差。',
  ),
  // 6) 主 agent：把发现交给 summarize 汇总定级（→ 7 是它的受限模型调用）
  toolTurn(5200, 80, [{ name: 'summarize', input: { findings: JSON.stringify(FINDINGS) } }]),
  // 7) summarize skill 内 ctx.llm：定级结论
  textTurn(
    2100,
    180,
    '定级 high：仓库存在硬编码口令与路径穿越两个可直接利用的 critical 问题，' +
      '另有 MD5 弱哈希、取款竞态、关闭 TLS 校验三个 major，需在上线前全部修复。',
  ),
  // 8) 主 agent：提交结构化评审报告（resultSchema 的隐藏 submit_result 工具）
  toolTurn(6400, 350, [
    {
      name: 'submit_result',
      input: {
        findings: FINDINGS,
        summary:
          '该服务存在硬编码口令、路径穿越两个 critical 问题与三个 major 问题，' +
          '集中在认证、上传与余额三个模块；定级 high，修复前不应上线。',
        riskLevel: 'high',
      },
    },
  ]),
];

console.log('[demo] 离线确定性模式：scriptedClient 剧本 8 步，零 API key、零网络');
await runReview({ client: scriptedClient(SCRIPT) });
