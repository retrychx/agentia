/* Agentia 预置场景脚本 —— 官网首屏的 trace 自播与 /playground 的模拟演示**共用同一份**。
 *
 * 抽出来的理由：这份数据既是首屏「真 trace 自播」的内容，也是 playground 的演示脚本。
 * 两处各存一份就会漂移（改了 playground 的叙事，首屏还讲旧故事）。回放游标见 ./trace-player.js。
 *
 * 字段参照真实 trace（span 树 + usage），**不发起任何真实模型调用**。
 *
 * 双语（2026-10-08 官网英文版）：文案用 `pt(zh, en)` 就地取一 —— 中英**贴在一起写**，
 * 而不是抽成两份平行数组（后者会漂移：改了一处忘了另一处，且没有任何东西看得出来）。
 * 语言来自 `<html lang>`，见 ./lang.js。跨语言的**结构**（span id / 事件类型 / 顺序）
 * 不随语言变，由 tests/docs/website-i18n.test.ts 逐例对拍。
 *
 * ========== 预置场景脚本 ==========
 * 事件类型：
 *  { wait }                          停顿 ms
 *  { think }                         主 agent 思考行
 *  { menu }                          高亮菜单里的能力 chip
 *  { spanStart:{id,parent,kind,name} }  trace 开 span（kind: run/capability/llm.turn）
 *     parent 语义与框架一致：capability 挂在【发起它的那个 llm.turn】下；主 agent 的
 *     llm.turn 挂 run 根；子 agent 内部的能力递归成该 capability 的子孙。
 *     capability span 只给 skill / subagent —— 框架里只有它们会 recorder.begin('capability',…)；
 *     普通工具与 @Prompt 资产是 turn 上的【事件】（见下方 tool / result），不建 span。
 *  { spanEnd:{id,ms,usage} }         trace 收尾（usage 累计到计数器）
 *  { llmOpen:{label,nested} }        终端面板开一个 llm.turn 输出块
 *  { stream }                        打字机流入最近的输出块
 *  { tool:{name,input,nested} }      tool_use 卡片 + 在最近一个 llm.turn 上记 tool.input 事件
 *  { result:{text,nested} }          tool_result 卡片 + 在同一 turn 上记 tool.output 事件
 *  { note }                          分区说明（如「SubAgent 内部」）
 *  { finalOpen } / { done }          最终报告块 / run 收尾
 */
import { pt } from './lang.js';

const SCENARIOS = [
  {
    id: 'doc-review',
    title: pt('审查一份文档', 'Review a document'),
    kind: pt('SubAgent · 隔离上下文', 'SubAgent · isolated context'),
    desc: pt(
      '主 agent 派出子代理独立审查长文档，中间批注不外泄，只有结论回流。',
      'The main agent dispatches a sub-agent to review a long document on its own — intermediate annotations stay inside, only the conclusion flows back.',
    ),
    task: pt(
      '审查 docs/weekly-report.md，指出结构与事实性问题',
      'Review docs/weekly-report.md and flag structural and factual problems',
    ),
    menu: [
      { name: 'subagent:doc_reviewer', desc: pt('隔离审查文档', 'Review a document in isolation') },
      { name: 'tool:read_file', desc: pt('读取文件片段', 'Read a file excerpt') },
      { name: 'prompt:review_checklist', desc: pt('审查清单资产', 'Review checklist asset') },
    ],
    script: [
      {
        wait: 500,
        think: pt(
          '任务是独立审查一份长文档——逐段批注会很长，不该污染主上下文。',
          'The task is to review a long document on its own — paragraph-by-paragraph annotation gets long and must not pollute the main context.',
        ),
      },
      {
        wait: 700,
        spanStart: { id: 's1', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      { llmOpen: { label: pt('llm.turn · 主 agent', 'llm.turn · main agent') } },
      {
        stream: pt(
          '审查类任务会在中间产生大量逐段批注，适合放进隔离的子代理：doc_reviewer 有独立循环和裁剪上下文，只把审查结论回流给我。',
          'A review task produces a lot of per-paragraph annotation along the way, so it belongs in an isolated sub-agent: doc_reviewer has its own loop and a trimmed context, and only the review conclusion flows back to me.',
        ),
      },
      { wait: 300, spanEnd: { id: 's1', ms: 1320, usage: { input: 1450, output: 88 } } },
      { wait: 400, menu: 'subagent:doc_reviewer' },
      {
        tool: {
          name: 'subagent:doc_reviewer',
          input: {
            task: pt(
              '审查 docs/weekly-report.md，指出结构与事实性问题',
              'Review docs/weekly-report.md and flag structural and factual problems',
            ),
            focus: pt(['结构', '事实', '数据口径'], ['structure', 'facts', 'metric definitions']),
          },
        },
      },
      {
        wait: 500,
        spanStart: { id: 's2', parent: 's1', kind: 'capability', name: 'subagent:doc_reviewer' },
      },
      {
        wait: 600,
        note: pt(
          '— SubAgent 内部（独立上下文，过程不外泄） —',
          '— inside the SubAgent (isolated context; the process does not leak out) —',
        ),
      },
      {
        wait: 300,
        spanStart: { id: 's3', parent: 's2', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      {
        llmOpen: { label: pt('llm.turn · doc_reviewer', 'llm.turn · doc_reviewer'), nested: true },
      },
      {
        stream: pt(
          '先读文档开头两百行，摸清结构，再逐节核对数据引用。',
          'Read the first two hundred lines to get the structure, then check the data references section by section.',
        ),
      },
      { wait: 200, spanEnd: { id: 's3', ms: 1580, usage: { input: 1180, output: 120 } } },
      {
        tool: {
          name: 'tool:read_file',
          input: { path: 'docs/weekly-report.md', offset: 0, limit: 200 },
          nested: true,
        },
      },
      {
        wait: 700,
        result: {
          text: pt(
            '已读取 200 行（全文共 342 行）。章节：摘要 / 核心指标 / 渠道分析 / 附录。',
            'Read 200 lines (342 in total). Sections: summary / core metrics / channel analysis / appendix.',
          ),
          nested: true,
        },
      },
      {
        wait: 400,
        spanStart: { id: 's5', parent: 's2', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      {
        llmOpen: { label: pt('llm.turn · doc_reviewer', 'llm.turn · doc_reviewer'), nested: true },
      },
      {
        stream: pt(
          '发现三处问题：①「核心指标」环比口径与附录不一致；②第 3 节引用的 DAU 与摘要对不上；③渠道分析缺少数据来源标注。继续读完剩余部分后汇总结论。',
          'Found three issues: ① the period-over-period definition for "core metrics" is inconsistent with the appendix; ② the DAU cited in section 3 does not match the summary; ③ the channel analysis has no source annotations. Reading the rest, then writing up the conclusion.',
        ),
      },
      { wait: 200, spanEnd: { id: 's5', ms: 2360, usage: { input: 1940, output: 220 } } },
      {
        wait: 500,
        result: {
          text: pt(
            '审查完成：3 处结构问题、2 处事实存疑、1 处数据口径不一致。已按章节给出逐条清单与修改建议。',
            'Review complete: 3 structural issues, 2 factual doubts, 1 inconsistent metric definition. A per-section checklist with suggested edits is ready.',
          ),
        },
      },
      { spanEnd: { id: 's2', ms: 6840, usage: { input: 3120, output: 340 } } },
      {
        wait: 600,
        note: pt(
          '— 回到主 agent（只有结论回流） —',
          '— back to the main agent (only the conclusion flows back) —',
        ),
      },
      {
        wait: 300,
        spanStart: { id: 's6', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      { finalOpen: {} },
      {
        stream: pt(
          '文档审查结论\n\n① 结构：摘要与正文的指标口径不一致（第 2 节）；渠道分析缺数据来源标注。\n② 事实：第 3 节 DAU「12.4 万」与摘要「11.8 万」冲突，建议以数仓口径为准。\n③ 建议：统一环比定义，附录补充取数 SQL 与统计窗口。\n\n详细逐条清单已由 doc_reviewer 归档，可按需调取。',
          'Document review conclusion\n\n① Structure: the summary and body disagree on metric definitions (section 2); the channel analysis is missing source annotations.\n② Facts: the DAU "124k" in section 3 conflicts with "118k" in the summary — go with the warehouse definition.\n③ Suggestions: unify the period-over-period definition and add the extraction SQL and the statistical window to the appendix.\n\nThe detailed item-by-item checklist was archived by doc_reviewer and can be pulled on demand.',
        ),
      },
      {
        wait: 300,
        spanEnd: { id: 's6', ms: 1740, usage: { input: 2680, output: 310, cacheRead: 2340 } },
      },
      { done: {} },
    ],
  },
  {
    id: 'weekly-report',
    title: pt('生成上周运营周报', "Generate last week's operations report"),
    kind: pt('Skill · 代码控制流程', 'Skill · code-controlled flow'),
    desc: pt(
      '先取数，再交给 Skill：调几次模型、怎么加工，全由代码决定。',
      'Fetch the data first, then hand it to a Skill: how many model calls happen and how the result is assembled are decided by code.',
    ),
    task: pt(
      '拉取上周核心指标，生成一份运营周报',
      "Pull last week's core metrics and generate an operations report",
    ),
    menu: [
      { name: 'tool:query_metrics', desc: pt('查询运营指标', 'Query operations metrics') },
      {
        name: 'skill:weekly_report',
        desc: pt('代码控制的成稿流程', 'A code-controlled drafting flow'),
      },
      { name: 'prompt:report_style', desc: pt('周报文体资产', 'Report style asset') },
    ],
    script: [
      {
        wait: 500,
        think: pt(
          '需要真实的上周数据，再按固定流程成稿——取数用 Tool，成稿用 Skill。',
          "We need last week's real data, then a fixed drafting flow — a Tool to fetch, a Skill to draft.",
        ),
      },
      {
        wait: 700,
        spanStart: { id: 's1', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      { llmOpen: { label: pt('llm.turn · 主 agent', 'llm.turn · main agent') } },
      {
        stream: pt(
          '分两步：先用 query_metrics 拉上周核心指标，再交给 weekly_report 这个 Skill——它的成稿流程（调几次模型、怎么加工）是代码写死的，产出稳定可复现。',
          "Two steps: first pull last week's core metrics with query_metrics, then hand them to the weekly_report Skill — its drafting flow (how many model calls, how the data is processed) is hard-coded, so the output is stable and reproducible.",
        ),
      },
      { wait: 300, spanEnd: { id: 's1', ms: 1180, usage: { input: 1320, output: 74 } } },
      { wait: 400, menu: 'tool:query_metrics' },
      {
        tool: {
          name: 'tool:query_metrics',
          input: { metrics: ['dau', 'wau', 'retention_d7', 'revenue'], week: '2026-W36' },
        },
      },
      {
        wait: 800,
        result: {
          text: pt(
            'DAU 均值 118,420（环比 +3.1%）；WAU 402,311；7 日留存 41.2%；营收 ¥2.31M（环比 -1.4%）。',
            'Average DAU 118,420 (+3.1% WoW); WAU 402,311; 7-day retention 41.2%; revenue ¥2.31M (-1.4% WoW).',
          ),
        },
      },
      { wait: 500, menu: 'skill:weekly_report' },
      {
        tool: {
          name: 'skill:weekly_report',
          input: { week: '2026-W36', data: pt('见上一条指标结果', 'see the metric result above') },
        },
      },
      {
        wait: 400,
        spanStart: { id: 's3', parent: 's1', kind: 'capability', name: 'skill:weekly_report' },
      },
      {
        wait: 600,
        note: pt(
          '— Skill 内部（ctx.llm() 由代码显式调用） —',
          '— inside the Skill (ctx.llm() is called explicitly by code) —',
        ),
      },
      {
        wait: 300,
        spanStart: { id: 's4', parent: 's3', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      {
        llmOpen: { label: pt('ctx.llm() · 数据解读', 'ctx.llm() · read the data'), nested: true },
      },
      {
        stream: pt(
          '解读指标：活跃度上行但营收微降，增长质量需关注；留存 41.2% 高于行业基准。',
          'Reading the metrics: engagement is up while revenue dips slightly, so growth quality is worth watching; retention at 41.2% is above the industry baseline.',
        ),
      },
      { wait: 200, spanEnd: { id: 's4', ms: 1990, usage: { input: 1480, output: 210 } } },
      {
        wait: 400,
        spanStart: { id: 's5', parent: 's3', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      {
        llmOpen: {
          label: pt('ctx.llm() · 按模板成稿', 'ctx.llm() · draft from the template'),
          nested: true,
        },
      },
      {
        stream: pt(
          '按周报模板组织成三段：核心指标速览 / 异动分析 / 下周跟进项。',
          "Organize into the report template's three sections: core metrics at a glance / notable changes / next week's follow-ups.",
        ),
      },
      { wait: 200, spanEnd: { id: 's5', ms: 2470, usage: { input: 1380, output: 250 } } },
      {
        wait: 500,
        result: {
          text: pt(
            '周报已成稿：三段式结构，含 4 项指标、2 条异动解读、3 项跟进建议。',
            'The report is drafted: a three-section structure with 4 metrics, 2 change notes and 3 follow-up suggestions.',
          ),
        },
      },
      { spanEnd: { id: 's3', ms: 5210, usage: { input: 2860, output: 460 } } },
      {
        wait: 600,
        spanStart: { id: 's6', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      { finalOpen: {} },
      {
        stream: pt(
          '运营周报 · 2026-W36\n\n核心指标：DAU 118,420（+3.1%）、WAU 402,311、7 日留存 41.2%、营收 ¥2.31M（-1.4%）。\n异动：活跃度与营收背离，建议排查付费转化漏斗。\n跟进：① 转化漏斗分渠道拆解；② 留存人群画像复核；③ 下周三前出营收归因简报。',
          'Operations report · 2026-W36\n\nCore metrics: DAU 118,420 (+3.1%), WAU 402,311, 7-day retention 41.2%, revenue ¥2.31M (-1.4%).\nNotable change: engagement and revenue diverge — investigate the paid conversion funnel.\nFollow-ups: ① break the conversion funnel down by channel; ② recheck the retention cohort profile; ③ a revenue attribution brief by next Wednesday.',
        ),
      },
      {
        wait: 300,
        spanEnd: {
          id: 's6',
          ms: 1490,
          usage: { input: 2410, output: 290, cacheRead: 2180, cacheCreation: 190 },
        },
      },
      { done: {} },
    ],
  },
  {
    id: 'weather-trip',
    title: pt('查天气并给出出行建议', 'Check the weather and suggest a trip plan'),
    kind: pt('Tool + Prompt · 轻量编排', 'Tool + Prompt · light orchestration'),
    desc: pt(
      '两次工具调用 + 一次文本资产拉取，主 agent 汇总成出行建议。',
      'Two tool calls plus one text-asset pull, and the main agent assembles a travel suggestion.',
    ),
    task: pt(
      '周末从上海去杭州，查天气并给出出行建议',
      'A weekend trip from Shanghai to Hangzhou: check the weather and suggest a plan',
    ),
    menu: [
      { name: 'tool:get_weather', desc: pt('查询城市天气', 'Look up city weather') },
      { name: 'prompt:packing_playbook', desc: pt('出行清单资产', 'Trip checklist asset') },
    ],
    script: [
      {
        wait: 500,
        think: pt(
          '需要两地天气，再看有没有出行类的提示词资产可用。',
          'We need the weather in both cities, and let me see whether a trip-related prompt asset is available.',
        ),
      },
      {
        wait: 700,
        spanStart: { id: 's1', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      { llmOpen: { label: pt('llm.turn · 主 agent', 'llm.turn · main agent') } },
      {
        stream: pt(
          '先查上海和杭州周末的天气；菜单里还有一份 packing_playbook 文本资产，适合拉进上下文辅助给建议。',
          'First check the weekend weather in Shanghai and Hangzhou; the menu also has a packing_playbook text asset worth pulling into context to help with the advice.',
        ),
      },
      { wait: 300, spanEnd: { id: 's1', ms: 980, usage: { input: 1150, output: 62 } } },
      { wait: 400, menu: 'tool:get_weather' },
      { tool: { name: 'tool:get_weather', input: { city: pt('上海', 'Shanghai') } } },
      {
        wait: 600,
        result: {
          text: pt(
            '上海：周六晴 24~31°C，周日多云 23~29°C，东南风 3 级。',
            'Shanghai: Sat sunny 24–31°C, Sun cloudy 23–29°C, SE wind force 3.',
          ),
        },
      },
      { tool: { name: 'tool:get_weather', input: { city: pt('杭州', 'Hangzhou') } } },
      {
        wait: 600,
        result: {
          text: pt(
            '杭州：周六阵雨转晴 23~30°C，周日晴 22~28°C，湿度 78%。',
            'Hangzhou: Sat showers clearing to sunny 23–30°C, Sun sunny 22–28°C, humidity 78%.',
          ),
        },
      },
      { wait: 500, menu: 'prompt:packing_playbook' },
      { tool: { name: 'prompt:packing_playbook', input: {} } },
      {
        wait: 500,
        result: {
          text: pt(
            '已拉取文本资产：短途出行清单（雨具 / 防晒 / 证件 / 充电宝……），共 640 字注入上下文。',
            'Text asset pulled: short-trip checklist (rain gear / sunscreen / ID / power bank …), 640 characters injected into context.',
          ),
        },
      },
      {
        wait: 600,
        spanStart: { id: 's5', parent: 'root', kind: 'llm.turn', name: 'claude-opus-5' },
      },
      { finalOpen: {} },
      {
        stream: pt(
          '出行建议 · 上海 → 杭州（周末）\n\n天气：杭州周六上午有阵雨，午后转晴；周日全晴。建议周六午后再进景区。\n衣物：白天 28~30°C 短袖即可，湿度大，备一件速干外套。\n装备：折叠伞必带；防晒 SPF30+；高铁往返注意返程末班。\n行程：周六午后西湖东线，周日早起灵隐寺避开人流。',
          'Trip plan · Shanghai → Hangzhou (weekend)\n\nWeather: Hangzhou has showers Saturday morning, clearing in the afternoon; Sunday is clear all day. Go into the scenic area Saturday afternoon.\nClothing: 28–30°C by day, short sleeves are fine; humidity is high, so bring a quick-dry jacket.\nGear: a folding umbrella is a must; sunscreen SPF30+; mind the last train home if you go by high-speed rail.\nItinerary: the east shore of West Lake on Saturday afternoon, Lingyin Temple early Sunday to beat the crowds.',
        ),
      },
      {
        wait: 300,
        spanEnd: { id: 's5', ms: 1620, usage: { input: 2260, output: 340, cacheRead: 2010 } },
      },
      { done: {} },
    ],
  },
];

export { SCENARIOS };
