import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadEnvFile } from '../../src/index.js';
// parseEnvText 是模块级 export（测试用），**刻意不进公共面** —— 进了 src/index.ts 就会连带要求
// 官网 API 页反向全覆盖，而它是纯实现细节
import { parseEnvText } from '../../src/toolkit/env.js';

/** 在一个临时目录里放一份 .env，跑完即删（不碰仓库、不碰真实 cwd） */
function withEnvFile(text: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agentia-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, text);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 跑一段会改 process.env 的断言，结束后把动过的键恢复原状（键是测试间共享的全局状态） */
function withEnvKeys<T>(keys: string[], fn: () => T): T {
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('parseEnvText（.env 解析）', () => {
  it('KEY=VALUE / 注释 / 空行 / export 前缀 / = 两侧空白', () => {
    const parsed = parseEnvText(
      ['# 注释整行', '', 'A=1', 'export B=2', 'C = 3', '  D  =  spaced  ', '', '# 末尾注释'].join(
        '\n',
      ),
    );
    assert.deepEqual(parsed, { A: '1', B: '2', C: '3', D: 'spaced' });
  });

  it('引号：双引号认转义、单引号原样、未加引号里 ` #` 起为行内注释', () => {
    const parsed = parseEnvText(
      [
        'A="line1\\nline2"',
        'B="quote\\"in"',
        "C='raw\\nnot-escaped'",
        'D=value # 这是注释',
        'E=#notacomment',
        'F=',
      ].join('\n'),
    );
    assert.equal(parsed.A, 'line1\nline2');
    assert.equal(parsed.B, 'quote"in');
    assert.equal(parsed.C, 'raw\\nnot-escaped');
    assert.equal(parsed.D, 'value');
    // `#` 紧贴值（前面没有空白）不当注释 —— 否则含 # 的 token 会被吃掉
    assert.equal(parsed.E, '#notacomment');
    assert.equal(parsed.F, '', '空值是合法值，不是「没有这个键」');
  });

  it('CRLF 与 BOM（Windows 记事本存过的文件）不影响第一个键', () => {
    const parsed = parseEnvText('\uFEFFA=1\r\nB=2\r\n');
    assert.deepEqual(parsed, { A: '1', B: '2' });
  });

  it('既不是 KEY=VALUE 也不是注释的行 → 抛错并指出行号（不静默跳过）', () => {
    assert.throws(() => parseEnvText('A=1\n这里写错了\n'), /\.env 第 2 行不是 KEY=VALUE/);
  });

  it('键名非法 → 抛错（含 `=` 开头、数字开头）', () => {
    assert.throws(() => parseEnvText('1A=x\n'), /键名非法/);
    assert.throws(() => parseEnvText('=x\n'), /键名非法/);
    // 键名带空格且去掉空白后为空的情况
    assert.throws(() => parseEnvText('  =x\n'), /键名非法/);
  });
});

describe('loadEnvFile（读进 process.env）', () => {
  it('文件不存在 → 静默返回 {}，不抛错（首次 clone / CI 的正常路径）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentia-env-'));
    try {
      assert.deepEqual(loadEnvFile({ path: join(dir, 'nope.env') }), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写进 process.env，并返回本次生效的键', () => {
    withEnvKeys(['AGENTIA_T_A1', 'AGENTIA_T_A2'], () => {
      delete process.env.AGENTIA_T_A1;
      delete process.env.AGENTIA_T_A2;
      withEnvFile('AGENTIA_T_A1=hello\nAGENTIA_T_A2=world\n', (path) => {
        assert.deepEqual(loadEnvFile({ path }), { AGENTIA_T_A1: 'hello', AGENTIA_T_A2: 'world' });
        assert.equal(process.env.AGENTIA_T_A1, 'hello');
        assert.equal(process.env.AGENTIA_T_A2, 'world');
      });
    });
  });

  it('已有环境变量优先（缺省不覆盖）—— CI / docker / 命令行显式变量永远赢过文件', () => {
    withEnvKeys(['AGENTIA_T_PRIO'], () => {
      process.env.AGENTIA_T_PRIO = 'from-real-env';
      withEnvFile('AGENTIA_T_PRIO=from-file\n', (path) => {
        // 返回值只含「真正写进去的键」—— 被挡下的不在内，据此可判断「到底生效没」
        assert.deepEqual(loadEnvFile({ path }), {});
        assert.equal(process.env.AGENTIA_T_PRIO, 'from-real-env');
      });
    });
  });

  it('空串也算「已定义」→ 不覆盖（否则 `FOO= npm run` 这种清空写法会被文件里的值复活）', () => {
    withEnvKeys(['AGENTIA_T_EMPTY'], () => {
      process.env.AGENTIA_T_EMPTY = '';
      withEnvFile('AGENTIA_T_EMPTY=from-file\n', (path) => {
        assert.deepEqual(loadEnvFile({ path }), {});
        assert.equal(process.env.AGENTIA_T_EMPTY, '');
      });
    });
  });

  it('override: true → 文件覆盖已存在的环境变量', () => {
    withEnvKeys(['AGENTIA_T_OVR'], () => {
      process.env.AGENTIA_T_OVR = 'from-real-env';
      withEnvFile('AGENTIA_T_OVR=from-file\n', (path) => {
        assert.deepEqual(loadEnvFile({ path, override: true }), { AGENTIA_T_OVR: 'from-file' });
        assert.equal(process.env.AGENTIA_T_OVR, 'from-file');
      });
    });
  });

  it('部分被挡：返回值只列真正生效的键', () => {
    withEnvKeys(['AGENTIA_T_X', 'AGENTIA_T_Y'], () => {
      process.env.AGENTIA_T_X = 'kept';
      delete process.env.AGENTIA_T_Y;
      withEnvFile('AGENTIA_T_X=file\nAGENTIA_T_Y=file\n', (path) => {
        assert.deepEqual(loadEnvFile({ path }), { AGENTIA_T_Y: 'file' });
        assert.equal(process.env.AGENTIA_T_X, 'kept');
      });
    });
  });

  it('文件内容非法 → 抛错（不是静默当空文件）', () => {
    withEnvFile('这不是一行配置\n', (path) => {
      assert.throws(() => loadEnvFile({ path }), /第 1 行不是 KEY=VALUE/);
    });
  });
});
