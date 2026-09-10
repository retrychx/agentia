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
    for (const key of Object.getOwnPropertyNames(proto)) {
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

/** 单元名解析：spec.name 缺省取方法名；私有符号方法名必须显式给 name。 */
export function unitName(spec: { name?: string }, key: string | symbol, kind: string): string {
  if (typeof spec.name === 'string') return spec.name;
  if (typeof key !== 'string') {
    throw new Error(`${kind} 需要显式 name（方法名为私有符号 ${String(key)}）`);
  }
  return key;
}
