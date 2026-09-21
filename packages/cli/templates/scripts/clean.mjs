// 构建前清掉 dist/ —— **必须**做，而且必须在 tsc 之前。
//
// 为什么（这不是洁癖，是生产缺陷）：tsc **不会删除**它不再产出的文件。删掉（或改名）一个能力
// 之后重新 `npm run build`，`dist/<分类>/<旧名>/index.js` 会原样留着 —— 而生产形态的入口
// （`node dist/main.js`）是按**本文件位置**去 discover `dist/<分类>/` 的，于是那个已经删掉的
// 能力**仍然被加载进菜单**：模型还能调它，trace 里也还能出现它。源码里找不到、进程里却有，
// 这是最难查的一类不一致。
//
// 原子性说明：这是「先删后建」，构建中途失败会留下不完整的 dist（不是半新旧混合）。要更强的话
// 可以改成「构建到临时目录再替换」，但对脚手架项目来说那点复杂度不值 —— 失败时重跑即可，
// 而**不做**这一步的后果是静默的错误行为（上面那段），两害相权取其轻。
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
rmSync(dist, { recursive: true, force: true });
