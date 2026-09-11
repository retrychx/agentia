/**
 * Agentia —— 单元收集器共用内核。
 *
 * 四类单元（tool/skill/subagent/prompt）的装饰器都只把「方法函数 → spec」登记进
 * 各自的 WeakMap；收集器在容器实例解析后沿原型链扫描出被装饰的方法。
 * 本模块是这一扫描的唯一实现，四个 collect* 只做各自单元形态的组装。
 */

/** 一次扫描命中：方法 key、原型上的方法函数、登记的 spec。 */
export interface DecoratedMethod<S> {
  key: string | symbol;
  fn: Function;
  spec: S;
}

/**
 * 沿实例原型链扫描被装饰的方法（子类 → 父类）。
 * override 语义：只在命中装饰器时标记 key —— 子类未装饰的 override 不挡
 * 父类的 spec（spec 沿原型链继承，调用仍走实例上的子类实现）。
 */
export function scanDecoratedMethods<S>(
  instance: object,
  registry: WeakMap<Function, S>,
): DecoratedMethod<S>[] {
  const found: DecoratedMethod<S>[] = [];
  const seen = new Set<string | symbol>();

  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    // Reflect.ownKeys 含 symbol key：symbol 命名的装饰方法也会被找到，
    // 无显式 name 时由 unitName 抛出提示（而非静默忽略）
    for (const key of Reflect.ownKeys(proto)) {
      if (seen.has(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc || typeof desc.value !== 'function') continue;
      const spec = registry.get(desc.value as Function);
      if (!spec) continue; // 未装饰的 override 不标 seen，父类 spec 继续生效
      seen.add(key);
      found.push({ key, fn: desc.value as Function, spec });
    }
    proto = Object.getPrototypeOf(proto);
  }
  return found;
}

/** 装饰器收到的标准 context 子集（本框架只用到这三个字段） */
export interface UnitDecoratorContext {
  kind: string;
  name: string | symbol;
  /** 标准装饰器 context 的私有方法标记（`#method` 的 kind 同样是 'method'） */
  private?: boolean;
}

/**
 * 四类单元装饰器共用的目标守卫：只接类方法，且**拒绝私有方法**。
 *
 * 收集走 `Reflect.ownKeys`，私有名（#method）在其中不可见 —— 不拦的话单元会
 * 静默从菜单里消失，作者只能靠「模型说没有这个工具」反推。
 */
export function assertMethodTarget(context: UnitDecoratorContext, kind: string): void {
  if (context.kind !== 'method') {
    throw new Error(`${kind} 只能修饰类方法，收到 kind=${String(context.kind)}`);
  }
  if (context.private) {
    throw new Error(`${kind} 不支持私有方法（#method）：收集用 Reflect.ownKeys，私有名不可见`);
  }
}

/** 单元名解析：spec.name 缺省取方法名；私有符号方法名必须显式给 name。 */
export function unitName(spec: { name?: string }, key: string | symbol, kind: string): string {
  if (typeof spec.name === 'string') return spec.name;
  if (typeof key !== 'string') {
    throw new Error(`${kind} 需要显式 name（方法名为私有符号 ${String(key)}）`);
  }
  return key;
}
