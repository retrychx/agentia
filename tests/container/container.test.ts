import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../../src/index.js';

describe('Container（显式 DI）', () => {
  it('value / factory+deps / class+deps 三态解析', () => {
    class Base {
      hi() {
        return 'hi';
      }
    }
    class Derived {
      constructor(public base: Base) {}
      greet() {
        return `${this.base.hi()}!`;
      }
    }
    const c = new Container().register(
      { provide: 'who', useValue: 'agent' },
      { provide: 'greeting', useFactory: (w: string) => `hello ${w}`, deps: ['who'] },
      { provide: 'base', useClass: Base },
      { provide: 'derived', useClass: Derived, deps: ['base'] },
    );
    assert.equal(c.resolve('greeting'), 'hello agent');
    assert.equal(c.resolve<Derived>('derived').greet(), 'hi!');
  });

  it('单例缓存：同 token 多次 resolve 返回同一实例', () => {
    class S {}
    const c = new Container().register({ provide: 's', useClass: S });
    assert.equal(c.resolve('s'), c.resolve('s'));
  });

  it('undefined 结果也缓存（不再每次重算）', () => {
    let calls = 0;
    const c = new Container().register({
      provide: 'u',
      useFactory: () => {
        calls++;
        return undefined;
      },
    });
    assert.equal(c.resolve('u'), undefined);
    assert.equal(c.resolve('u'), undefined);
    assert.equal(calls, 1);
  });

  it('循环依赖报出 token 链', () => {
    const c = new Container().register(
      { provide: 'a', useFactory: (b: unknown) => b, deps: ['b'] },
      { provide: 'b', useFactory: (a: unknown) => a, deps: ['a'] },
    );
    assert.throws(() => c.resolve('a'), /循环依赖.*a -> b -> a/);
  });

  it('未注册 token 与非法 provider 都抛错', () => {
    const c = new Container();
    assert.throws(() => c.resolve('missing'), /未注册的 provider/);
    assert.throws(() => c.register({ foo: 1 } as never), /非法 provider/);
  });

  it('后注册覆盖先注册', () => {
    const c = new Container().register(
      { provide: 'k', useValue: 1 },
      { provide: 'k', useValue: 2 },
    );
    assert.equal(c.resolve('k'), 2);
  });

  it('覆盖发生在 resolve 之后也生效：重注册使缓存失效', () => {
    const c = new Container().register({ provide: 'k', useValue: 1 });
    assert.equal(c.resolve('k'), 1);
    c.register({ provide: 'k', useValue: 2 });
    assert.equal(c.resolve('k'), 2, '已缓存的旧实例必须被重注册冲掉');
  });

  it('重注册**传递**失效：依赖它的下游也重建（仅失效 token 自身不够）', () => {
    const c = new Container().register(
      { provide: 'cfg', useValue: { v: 1 } },
      { provide: 'svc', useFactory: (cfg: { v: number }) => ({ cfg }), deps: ['cfg'] },
      { provide: 'app', useFactory: (svc: { cfg: { v: number } }) => ({ svc }), deps: ['svc'] },
    );
    const first = c.resolve<{ svc: { cfg: { v: number } } }>('app');
    assert.equal(first.svc.cfg.v, 1);

    // 升级 cfg：svc/app 已在缓存里，若不传递失效会继续用「旧 cfg 造出来的」旧实例
    c.register({ provide: 'cfg', useValue: { v: 2 } });
    assert.equal(c.resolve<{ svc: { cfg: { v: number } } }>('app').svc.cfg.v, 2, '下游必须跟着重建');
    assert.notEqual(c.resolve('app'), first);
  });
});
