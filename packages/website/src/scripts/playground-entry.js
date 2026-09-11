/* Playground 客户端入口：按序加载两个模块。
 * playground-real.js 依赖 playground.js 暴露的 window.AgentiaPlayground，
 * ESM 的同级 import 按声明顺序求值，顺序有保证（不再依赖 <script> 标签顺序）。 */
import './playground.js';
import './playground-real.js';
