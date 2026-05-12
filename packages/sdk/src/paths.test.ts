/**
 * paths.ts 单元测试。
 *
 * 关键不变量：
 *   - getRuntimeRoot：config > env > homedir 三级优先级，env override 不能被
 *     默认值偷偷覆盖（曾是 v0.0 的 bug：env 读到了但被错误的 ?? 顺序丢弃）
 *   - getUserDataDir / getPersonaDir：副作用是 mkdir -p；多次调用幂等
 *   - getPersonaFile：纯字符串拼接，<root>/personas/<id>.json
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type PathConfig,
  getPersonaDir,
  getPersonaFile,
  getRuntimeRoot,
  getUserDataDir,
} from './paths.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mosaiq-paths-test-'));
  vi.unstubAllEnvs();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('getRuntimeRoot', () => {
  it('uses explicit config.runtimeRoot when provided', () => {
    vi.stubEnv('MOSAIQ_RUNTIME_ROOT', '/should/be/ignored');
    const cfg: PathConfig = { runtimeRoot: tmpRoot };
    expect(getRuntimeRoot(cfg)).toBe(tmpRoot);
  });

  it('falls back to MOSAIQ_RUNTIME_ROOT env when no config supplied', () => {
    vi.stubEnv('MOSAIQ_RUNTIME_ROOT', tmpRoot);
    expect(getRuntimeRoot()).toBe(tmpRoot);
  });

  it('falls back to <homedir>/.mosaiq when neither config nor env set', () => {
    vi.stubEnv('MOSAIQ_RUNTIME_ROOT', '');
    const out = getRuntimeRoot();
    // homedir 在不同 OS 不同；只断言尾段
    expect(out.endsWith('.mosaiq')).toBe(true);
  });
});

describe('getUserDataDir', () => {
  it('returns <root>/profiles/<id> and creates the directory', () => {
    const dir = getUserDataDir('alice', { runtimeRoot: tmpRoot });
    expect(dir).toBe(join(tmpRoot, 'profiles', 'alice'));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('is idempotent (calling twice does not throw)', () => {
    const cfg: PathConfig = { runtimeRoot: tmpRoot };
    const a = getUserDataDir('bob', cfg);
    const b = getUserDataDir('bob', cfg);
    expect(a).toBe(b);
    expect(existsSync(a)).toBe(true);
  });

  it('isolates personas into separate subdirectories', () => {
    const cfg: PathConfig = { runtimeRoot: tmpRoot };
    const a = getUserDataDir('alice', cfg);
    const b = getUserDataDir('bob', cfg);
    expect(a).not.toBe(b);
    expect(a).toContain('alice');
    expect(b).toContain('bob');
  });
});

describe('getPersonaDir', () => {
  it('returns <root>/personas and creates it', () => {
    const dir = getPersonaDir({ runtimeRoot: tmpRoot });
    expect(dir).toBe(join(tmpRoot, 'personas'));
    expect(existsSync(dir)).toBe(true);
  });
});

describe('getPersonaFile', () => {
  it('returns <root>/personas/<id>.json', () => {
    const f = getPersonaFile('alice', { runtimeRoot: tmpRoot });
    expect(f).toBe(join(tmpRoot, 'personas', 'alice.json'));
  });

  it('does NOT create the file (only the parent directory)', () => {
    const f = getPersonaFile('charlie', { runtimeRoot: tmpRoot });
    expect(existsSync(f)).toBe(false);
    // 但父目录被 getPersonaDir 创建了
    expect(existsSync(join(tmpRoot, 'personas'))).toBe(true);
  });
});
