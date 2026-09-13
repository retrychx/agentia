/* @migor/trace-view —— Agentia trace 调用树渲染器（框架无关、零依赖）。
 * 官网 playground 与 CLI inspector 共用同一份，避免两处渲染漂移。 */

export { createTraceView, unitTypeOf, UNIT_ICO, fmtArg, fmtNum, fmtMs } from './view.js';
export { playTrace } from './fromTrace.js';
export { summarizeTrace, renderSummary } from './summary.js';
