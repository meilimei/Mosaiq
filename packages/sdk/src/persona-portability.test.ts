/**
 * persona-portability.ts 单元测试。
 *
 * 验证导入 / 导出的关键不变量：
 *   - 默认脱敏代理密码（避免凭据泄漏到 IM / git）
 *   - 显式 stripSecrets:false 时保留密码（dev 内部备份场景）
 *   - 导入时 schema 校验（坏 JSON 一律拒绝）
 *   - 三种 ID 冲突策略（error / rename / overwrite）行为正确
 *   - 导入后 launchCount / lastLaunchedAt 重置（fresh 启动语义）
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Persona, PersonaId } from '@mosaiq/persona-schema';
import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';

import {
  exportPersonaJson,
  importPersonaJson,
  parsePersonaJson,
  serializePersona,
} from './persona-portability.js';
import { loadPersona, personaExists, savePersona } from './persona-store.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mosaiq-portability-test-'));
});

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

function makePersonaWithProxy(overrides: { id?: string } = {}): Persona {
  return createWin11ChromeUsPersona({
    id: overrides.id ?? 'export-test',
    displayName: 'Export Test',
    tags: ['reddit', 'us'],
    notes: 'a real proxy attached',
    proxy: {
      protocol: 'http',
      host: 'residential.iproyal.com',
      port: 12321,
      username: 'brd-customer-xxx-zone-residential-session-001',
      password: 'super-secret-pwd-do-not-leak',
      label: 'iproyal-us-001',
      bypassList: [],
    },
  });
}

describe('serializePersona', () => {
  it('strips proxy.password by default (核心安全保证)', () => {
    const persona = makePersonaWithProxy();
    const json = serializePersona(persona);
    const parsed = JSON.parse(json) as Persona;

    expect(parsed.network.proxy?.password).toBe('');
    // 其他代理字段保留 —— 导入端能识别出代理结构，只需重填密码
    expect(parsed.network.proxy?.host).toBe('residential.iproyal.com');
    expect(parsed.network.proxy?.username).toBe(
      'brd-customer-xxx-zone-residential-session-001',
    );
    expect(parsed.network.proxy?.label).toBe('iproyal-us-001');
  });

  it('keeps password when stripSecrets is explicitly false', () => {
    const persona = makePersonaWithProxy();
    const json = serializePersona(persona, { stripSecrets: false });
    const parsed = JSON.parse(json) as Persona;
    expect(parsed.network.proxy?.password).toBe('super-secret-pwd-do-not-leak');
  });

  it('does not mutate the input persona (structuredClone safety)', () => {
    const persona = makePersonaWithProxy();
    const originalPwd = persona.network.proxy?.password;
    serializePersona(persona); // strip
    expect(persona.network.proxy?.password).toBe(originalPwd);
  });

  it('handles persona without proxy (no-op for stripping)', () => {
    const persona = createWin11ChromeUsPersona({ id: 'no-proxy', displayName: 'X' });
    const json = serializePersona(persona);
    const parsed = JSON.parse(json) as Persona;
    expect(parsed.network.proxy).toBeUndefined();
  });

  it('produces 2-space indented JSON (人类可读 + git diff 友好)', () => {
    const persona = createWin11ChromeUsPersona({ id: 'fmt', displayName: 'X' });
    const json = serializePersona(persona);
    expect(json).toContain('\n  "metadata"');
    expect(json).toContain('\n    "id"');
  });
});

describe('exportPersonaJson', () => {
  it('reads from disk and serializes', () => {
    const persona = makePersonaWithProxy({ id: 'on-disk' });
    savePersona(persona, { runtimeRoot: tmpRoot });

    const json = exportPersonaJson(persona.metadata.id, { runtimeRoot: tmpRoot });
    const parsed = JSON.parse(json) as Persona;
    expect(parsed.metadata.id).toBe('on-disk');
    expect(parsed.network.proxy?.password).toBe(''); // default strip
  });

  it('throws when persona does not exist on disk', () => {
    expect(() =>
      exportPersonaJson('nonexistent' as PersonaId, { runtimeRoot: tmpRoot }),
    ).toThrow(/not found/i);
  });
});

describe('parsePersonaJson', () => {
  it('round-trips via serialize → parse', () => {
    const persona = createWin11ChromeUsPersona({ id: 'roundtrip', displayName: 'X' });
    const json = serializePersona(persona, { stripSecrets: false });
    const back = parsePersonaJson(json);
    expect(back.metadata.id).toBe('roundtrip');
    expect(back.system.os.family).toBe('windows');
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePersonaJson('{not json')).toThrow();
  });

  it('throws on schema violation (e.g. missing metadata)', () => {
    expect(() => parsePersonaJson('{"foo": "bar"}')).toThrow();
  });

  it('throws on invalid PersonaId regex', () => {
    const persona = createWin11ChromeUsPersona({ id: 'valid-id', displayName: 'X' });
    const broken = JSON.parse(serializePersona(persona)) as Persona;
    // 注入一个不合法的 id：大写 + 数字开头
    (broken.metadata as { id: string }).id = '1NotKebab';
    expect(() => parsePersonaJson(JSON.stringify(broken))).toThrow();
  });
});

describe('importPersonaJson', () => {
  it('imports a fresh persona to disk and resets launch stats', () => {
    const source = createWin11ChromeUsPersona({ id: 'fresh-import', displayName: 'X' });
    // 模拟一个有启动历史的 persona JSON
    const withHistory: Persona = {
      ...source,
      metadata: {
        ...source.metadata,
        launchCount: 42,
        lastLaunchedAt: '2024-01-01T00:00:00.000Z',
      },
    };
    const json = JSON.stringify(withHistory);

    const imported = importPersonaJson(json, { runtimeRoot: tmpRoot });

    expect(imported.metadata.id).toBe('fresh-import');
    // launchCount / lastLaunchedAt 必须被重置（新设备 = fresh start 语义）
    expect(imported.metadata.launchCount).toBe(0);
    expect(imported.metadata.lastLaunchedAt).toBeNull();
    // 文件实际落盘
    expect(personaExists(imported.metadata.id, { runtimeRoot: tmpRoot })).toBe(true);
  });

  describe('ID conflict policies', () => {
    it("'error' (default) throws when ID exists", () => {
      const persona = createWin11ChromeUsPersona({ id: 'conflict', displayName: 'A' });
      savePersona(persona, { runtimeRoot: tmpRoot });
      const json = serializePersona(persona);

      expect(() => importPersonaJson(json, { runtimeRoot: tmpRoot })).toThrow(
        /already exists/i,
      );
    });

    it("'rename' generates <id>-imported on first conflict", () => {
      const persona = createWin11ChromeUsPersona({ id: 'rename-test', displayName: 'A' });
      savePersona(persona, { runtimeRoot: tmpRoot });

      const imported = importPersonaJson(serializePersona(persona), {
        runtimeRoot: tmpRoot,
        onConflict: 'rename',
      });
      expect(imported.metadata.id).toBe('rename-test-imported');
      expect(personaExists('rename-test' as PersonaId, { runtimeRoot: tmpRoot })).toBe(true);
      expect(
        personaExists('rename-test-imported' as PersonaId, { runtimeRoot: tmpRoot }),
      ).toBe(true);
    });

    it("'rename' generates <id>-imported-2 on second conflict", () => {
      const persona = createWin11ChromeUsPersona({ id: 'rename-twice', displayName: 'A' });
      savePersona(persona, { runtimeRoot: tmpRoot });
      // 先制造一次 -imported
      importPersonaJson(serializePersona(persona), {
        runtimeRoot: tmpRoot,
        onConflict: 'rename',
      });
      // 第二次冲突应该走 -imported-2
      const second = importPersonaJson(serializePersona(persona), {
        runtimeRoot: tmpRoot,
        onConflict: 'rename',
      });
      expect(second.metadata.id).toBe('rename-twice-imported-2');
    });

    it("'overwrite' replaces the existing persona file (id unchanged)", () => {
      const original = createWin11ChromeUsPersona({
        id: 'overwrite-test',
        displayName: 'Original',
      });
      savePersona(original, { runtimeRoot: tmpRoot });

      const replacement: Persona = {
        ...original,
        metadata: { ...original.metadata, displayName: 'Replaced' },
      };

      const imported = importPersonaJson(JSON.stringify(replacement), {
        runtimeRoot: tmpRoot,
        onConflict: 'overwrite',
      });

      expect(imported.metadata.id).toBe('overwrite-test');
      expect(imported.metadata.displayName).toBe('Replaced');
      // 磁盘上确实是 'Replaced'
      const fromDisk = loadPersona('overwrite-test' as PersonaId, {
        runtimeRoot: tmpRoot,
      });
      expect(fromDisk.metadata.displayName).toBe('Replaced');
    });
  });

  it('rejects invalid JSON before touching disk', () => {
    expect(() =>
      importPersonaJson('{not-json}', { runtimeRoot: tmpRoot }),
    ).toThrow();
  });
});
