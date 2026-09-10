// 故意引用不存在的模块：用于触发 discoverProviders 的「入口加载失败」路径
import 'agentia-fixture-nonexistent-module';

export default class LoadfailUnit {}
