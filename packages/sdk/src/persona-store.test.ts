/**
 * persona-store 测试：重点覆盖 updatePersona / clonePersona 的核心保证。
 *
 * 这些函数决定 v0.1 的反检测关键行为：
 *   - update 不能破坏指纹一致性（fingerprint / hardware 不动）
 *   - clone 必须派生全新 noise seeds（否则克隆出的 persona 会被识别为「同一设备」）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';

import {
  clonePersona,
  loadPersona,
  personaExists,
  savePersona,
  updatePersona,
} from './persona-store.js';
import type { PathConfig } from './paths.js';

let tmpRoot: string;
let cfg: PathConfig;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mosaiq-test-'));
  cfg = { runtimeRoot: tmpRoot };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSource() {
  const p = createWin11ChromeUsPersona({
    id: 'src',
    displayName: 'Source',
    tags: ['original'],
    notes: 'seed notes',
    timezone: 'America/New_York',
    proxy: {
      protocol: 'http',
      host: '1.2.3.4',
      port: 8080,
      username: 'u',
      password: 'p',
      label: 'orig',
    },
    masterSeed: 'deadbeef',
  });
  savePersona(p, cfg);
  return p;
}

describe('updatePersona', () => {
  it('updates metadata fields without touching fingerprint', () => {
    const src = makeSource();
    const updated = updatePersona('src', { displayName: 'New Name', notes: 'new' }, cfg);

    expect(updated.metadata.displayName).toBe('New Name');
    expect(updated.metadata.notes).toBe('new');
    // 硬件 / 指纹字段保持不变（反检测核心）
    expect(updated.fingerprint.canvas.noiseSeed).toBe(src.fingerprint.canvas.noiseSeed);
    expect(updated.fingerprint.webgl.noiseSeed).toBe(src.fingerprint.webgl.noiseSeed);
    expect(updated.fingerprint.audio.noiseSeed).toBe(src.fingerprint.audio.noiseSeed);
    expect(updated.hardware).toEqual(src.hardware);
    expect(updated.system.os).toEqual(src.system.os);
  });

  it('changes timezone without affecting locale or os', () => {
    const src = makeSource();
    const updated = updatePersona('src', { timezone: 'Asia/Tokyo' }, cfg);

    expect(updated.system.timezone).toBe('Asia/Tokyo');
    expect(updated.system.locale).toEqual(src.system.locale);
    expect(updated.system.os).toEqual(src.system.os);
  });

  it('proxy=null removes proxy', () => {
    makeSource();
    const updated = updatePersona('src', { proxy: null }, cfg);
    expect(updated.network.proxy).toBeUndefined();
  });

  it('proxy=undefined keeps existing proxy', () => {
    const src = makeSource();
    const updated = updatePersona('src', { displayName: 'X' }, cfg);
    expect(updated.network.proxy).toEqual(src.network.proxy);
  });

  it('proxy=object replaces proxy', () => {
    makeSource();
    const updated = updatePersona(
      'src',
      {
        proxy: {
          protocol: 'socks5',
          host: '9.9.9.9',
          port: 1080,
          bypassList: [],
        },
      },
      cfg,
    );
    expect(updated.network.proxy?.protocol).toBe('socks5');
    expect(updated.network.proxy?.host).toBe('9.9.9.9');
  });

  it('persists changes to disk (roundtrip)', () => {
    makeSource();
    updatePersona('src', { displayName: 'Persisted' }, cfg);
    const reloaded = loadPersona('src', cfg);
    expect(reloaded.metadata.displayName).toBe('Persisted');
  });

  it('bumps updatedAt', () => {
    // 用 fake timers 消除 Windows Date.now() ~15ms 精度导致的 flakiness
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
      const src = makeSource();
      vi.setSystemTime(new Date('2024-01-01T00:00:10.000Z'));
      const updated = updatePersona('src', { displayName: 'X' }, cfg);
      expect(src.metadata.updatedAt).toBe('2024-01-01T00:00:00.000Z');
      expect(updated.metadata.updatedAt).toBe('2024-01-01T00:00:10.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clonePersona', () => {
  it('derives new noise seeds (反检测核心保证)', () => {
    const src = makeSource();
    const cloned = clonePersona('src', { newId: 'clone-1', newDisplayName: 'Clone' }, cfg);

    // 所有指纹 seeds 必须不同，否则两个 persona 在反检测站会显示同一设备
    expect(cloned.fingerprint.canvas.noiseSeed).not.toBe(src.fingerprint.canvas.noiseSeed);
    expect(cloned.fingerprint.webgl.noiseSeed).not.toBe(src.fingerprint.webgl.noiseSeed);
    expect(cloned.fingerprint.audio.noiseSeed).not.toBe(src.fingerprint.audio.noiseSeed);
  });

  it('preserves hardware / browser / OS baseline', () => {
    const src = makeSource();
    const cloned = clonePersona('src', { newId: 'clone-2', newDisplayName: 'Clone' }, cfg);

    expect(cloned.hardware).toEqual(src.hardware);
    expect(cloned.browser).toEqual(src.browser);
    expect(cloned.system.os).toEqual(src.system.os);
    expect(cloned.system.locale).toEqual(src.system.locale);
    // 字体列表也必须保持 OS 一致
    expect(cloned.fingerprint.fontList.fonts).toEqual(src.fingerprint.fontList.fonts);
  });

  it('assigns new id / displayName / timestamps / resets launch stats', () => {
    makeSource();
    const cloned = clonePersona(
      'src',
      { newId: 'clone-three', newDisplayName: 'Clone 3' },
      cfg,
    );
    expect(cloned.metadata.id).toBe('clone-three');
    expect(cloned.metadata.displayName).toBe('Clone 3');
    expect(cloned.metadata.launchCount).toBe(0);
    expect(cloned.metadata.lastLaunchedAt).toBeNull();
  });

  it('defaults to copying tags / notes / timezone / proxy from source', () => {
    const src = makeSource();
    const cloned = clonePersona('src', { newId: 'clone-four', newDisplayName: 'C4' }, cfg);

    expect(cloned.metadata.tags).toEqual(src.metadata.tags);
    expect(cloned.metadata.notes).toBe(src.metadata.notes);
    expect(cloned.system.timezone).toBe(src.system.timezone);
    expect(cloned.network.proxy).toEqual(src.network.proxy);
  });

  it('newProxy=null produces a proxy-less clone', () => {
    makeSource();
    const cloned = clonePersona(
      'src',
      { newId: 'clone-five', newDisplayName: 'C5', newProxy: null },
      cfg,
    );
    expect(cloned.network.proxy).toBeUndefined();
  });

  it('overrides tags / notes / timezone when provided', () => {
    makeSource();
    const cloned = clonePersona(
      'src',
      {
        newId: 'clone-six',
        newDisplayName: 'C6',
        newTags: ['cloned'],
        newNotes: 'new notes',
        newTimezone: 'Asia/Tokyo',
      },
      cfg,
    );
    expect(cloned.metadata.tags).toEqual(['cloned']);
    expect(cloned.metadata.notes).toBe('new notes');
    expect(cloned.system.timezone).toBe('Asia/Tokyo');
  });

  it('throws if newId already exists', () => {
    makeSource();
    clonePersona('src', { newId: 'dup-id', newDisplayName: 'D1' }, cfg);

    expect(() =>
      clonePersona('src', { newId: 'dup-id', newDisplayName: 'D2' }, cfg),
    ).toThrow(/already exists/);
  });

  it('throws if source does not exist', () => {
    expect(() =>
      clonePersona('nonexistent', { newId: 'clone-seven', newDisplayName: 'C7' }, cfg),
    ).toThrow();
  });

  it('throws if newId is invalid (schema violation caught at save time)', () => {
    makeSource();
    // savePersona 现在在写盘前做 schema 校验
    expect(() =>
      clonePersona('src', { newId: 'ab', newDisplayName: 'Too Short' }, cfg),
    ).toThrow();
  });

  it('reproducible when masterSeed provided', () => {
    makeSource();
    const c1 = clonePersona(
      'src',
      { newId: 'clone-eight-a', newDisplayName: 'X', newMasterSeed: 'cafebabe' },
      cfg,
    );
    clonePersona(
      'src',
      { newId: 'clone-eight-b', newDisplayName: 'Y', newMasterSeed: 'cafebabe' },
      cfg,
    );
    const c2 = loadPersona('clone-eight-b', cfg);
    expect(c1.fingerprint.canvas.noiseSeed).toBe(c2.fingerprint.canvas.noiseSeed);
    expect(c1.fingerprint.webgl.noiseSeed).toBe(c2.fingerprint.webgl.noiseSeed);
  });

  it('persists clone to disk', () => {
    makeSource();
    clonePersona('src', { newId: 'clone-nine', newDisplayName: 'C9' }, cfg);
    expect(personaExists('clone-nine', cfg)).toBe(true);
    const reloaded = loadPersona('clone-nine', cfg);
    expect(reloaded.metadata.id).toBe('clone-nine');
  });
});
