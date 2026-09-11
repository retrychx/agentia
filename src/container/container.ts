/**
 * Agentia —— 最小显式 DI 容器（spec §4/§10：标准装饰器 + 显式 DI，不用
 * experimentalDecorators/emitDecoratorMetadata/reflect-metadata）。
 *
 * Provider 三态：useValue / useClass / useFactory(+deps)。
 * 依赖以字符串 token 显式声明，靠工厂解析期惰性求值；无构造器参数反射。
 * 容器按 app 粒度单例缓存；run 作用域的黑板/上下文不经过 DI，而由
 * RunContext(AsyncLocalStorage) 在 executeRun 内注入（见 run/context.ts）。
 */
export type Token = string;

export interface ValueProvider<T = unknown> {
  provide: Token;
  useValue: T;
}
export interface ClassProvider<T = unknown> {
  provide: Token;
  useClass: new (...args: never[]) => T;
  /** 构造器参数对应的依赖 token（按序注入）；无依赖可省略 */
  deps?: Token[];
}
export interface FactoryProvider<T = unknown> {
  provide: Token;
  useFactory: (...deps: unknown[]) => T;
  /** 与 useFactory 形参一一对应的依赖 token */
  deps?: Token[];
}

export type Provider<T = unknown> =
  | ValueProvider<T>
  | ClassProvider<T>
  | FactoryProvider<T>;

export function isProvider(p: unknown): p is Provider {
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof (p as { provide?: unknown }).provide === 'string' &&
    ('useValue' in (p as object) ||
      'useClass' in (p as object) ||
      'useFactory' in (p as object))
  );
}

export class Container {
  private readonly bindings = new Map<Token, Provider>();
  private readonly cache = new Map<Token, unknown>();
  /** 正在解析的 token 链，用于循环依赖检测 */
  private resolving: Token[] = [];

  /** 覆盖式注册（后注册覆盖先注册；同一 app 内同 token 重复注册视为升级） */
  register(...providers: Provider[]): this {
    for (const p of providers) {
      if (!isProvider(p)) {
        throw new Error(`非法 provider: ${JSON.stringify(p)}`);
      }
      this.bindings.set(p.provide, p);
      // 已解析过的缓存必须一起失效：否则「后注册覆盖先注册」只在首次 resolve 前成立
      // （重复 module 装配是常见场景，升级了 provider 却仍拿到旧实例）
      this.cache.delete(p.provide);
    }
    return this;
  }

  has(token: Token): boolean {
    return this.bindings.has(token);
  }

  resolve<T = unknown>(token: Token): T {
    // 用 has 判定命中：provider 值可以是 undefined，get 返回 undefined 不等于未缓存
    if (this.cache.has(token)) return this.cache.get(token) as T;

    const cycleAt = this.resolving.indexOf(token);
    if (cycleAt !== -1) {
      const chain = [...this.resolving.slice(cycleAt), token].join(' -> ');
      throw new Error(`循环依赖（DI）: ${chain}`);
    }

    const binding = this.bindings.get(token);
    if (!binding) {
      throw new Error(`未注册的 provider: "${token}"`);
    }

    this.resolving.push(token);
    let value: unknown;
    try {
      if ('useValue' in binding) {
        value = binding.useValue;
      } else if ('useClass' in binding) {
        const deps = (binding.deps ?? []).map((d) => this.resolve(d));
        value = new binding.useClass(...(deps as never[]));
      } else {
        const deps = (binding.deps ?? []).map((d) => this.resolve(d));
        value = binding.useFactory(...deps);
      }
    } finally {
      this.resolving.pop();
    }

    this.cache.set(token, value);
    return value as T;
  }

  /** 调试辅助 */
  registered(): Token[] {
    return [...this.bindings.keys()];
  }
}
