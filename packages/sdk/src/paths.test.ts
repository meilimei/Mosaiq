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
  getDetectionRunFile,
  getDetectionRunsDir,
  getDetectionRunsRoot,
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

describe('detection-runs path helpers', () => {
  it('getDetectionRunsRoot returns <root>/detection-runs and does NOT mkdir', () => {
    const root = getDetectionRunsRoot({ runtimeRoot: tmpRoot });
    expect(root).toBe(join(tmpRoot, 'detection-runs'));
    // 关键不变量：纯字符串拼接，读语义不副作用——副作用收敛到 saveDetectionRun
    expect(existsSync(root)).toBe(false);
  });

  it('getDetectionRunsDir returns <root>/detection-runs/<personaId> and does NOT mkdir', () => {
    const dir = getDetectionRunsDir('alice', { runtimeRoot: tmpRoot });
    expect(dir).toBe(join(tmpRoot, 'detection-runs', 'alice'));
    expect(existsSync(dir)).toBe(false);
  });

  it('getDetectionRunFile returns <root>/detection-runs/<personaId>/<runId>.json', () => {
    const f = getDetectionRunFile(
      'alice',
      '2026-05-17T10-00-00-000Z',
      { runtimeRoot: tmpRoot },
    );
    expect(f).toBe(
      join(
        tmpRoot,
        'detection-runs',
        'alice',
        '2026-05-17T10-00-00-000Z.json',
      ),
    );
    expect(existsSync(f)).toBe(false);
  });

  it('artifact dir (<...>/<runId>) is sibling of file (<...>/<runId>.json), prefix-aligned', () => {
    // 不直接 import getDetectionRunArtifactDir（住在 run-store.ts），但用 join 模拟
    // 以验证 paths.ts 的命名约定让两者天然 prefix-aligned。
    const file = getDetectionRunFile('alice', 'r1', { runtimeRoot: tmpRoot });
    const sibling = join(
      getDetectionRunsDir('alice', { runtimeRoot: tmpRoot }),
      'r1',
    );
    expect(file).toBe(`${sibling}.json`);
  });
});
