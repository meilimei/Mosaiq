/**
 * Phase 11.6 — pod 侧 context I/O 单测。
 *
 * 用真实 `tar` 二进制（CI Linux = GNU tar，dev Windows/macOS = bsdtar，两者都
 * 支持 -czf - / -xzf - / --exclude=）+ tmp 目录 + 注入的 fake fetch。
 *
 * 核心断言：snapshotContext → loadContext round-trip 后文件逐字节一致；cache 目录
 * 被排除；失败路径（404 空 context、size 超限、413、跨 project key、网络错误）行为
 * 正确且 snapshot 永不抛。
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadContext, snapshotContext } from './context-io.js';
import { decryptBlob, deriveKey } from './crypto.js';

const MASTER = randomBytes(32).toString('base64');
const BIG = 500 * 1024 * 1024; // effectively-unbounded maxBytes for round-trip tests

let srcDir: string;
let dstDir: string;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaiq-ctxio-'));
  srcDir = path.join(root, 'src');
  dstDir = path.join(root, 'dst');
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(dstDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(srcDir), { recursive: true, force: true });
});

/** Write a file (creating parent dirs) under base. */
async function writeFile(base: string, rel: string, content: string): Promise<void> {
  const full = path.join(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

async function readFileOrNull(base: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(base, rel), 'utf8');
  } catch {
    return null;
  }
}

/** fetch double that captures a PUT body and replies with the given status. */
function capturingPut(status = 204) {
  const captured: { body: Buffer | null } = { body: null };
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if (init?.body) {
      const b = init.body as unknown as Uint8Array;
      captured.body = Buffer.from(b);
    }
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

/** fetch double that returns a fixed blob for GET (download). */
function returningGet(blob: Buffer | null, status = 200) {
  return (async () =>
    new Response(blob as unknown as BodyInit | null, { status })) as unknown as typeof fetch;
}

describe('snapshotContext → loadContext round-trip', () => {
  it('round-trips files byte-for-byte', async () => {
    await writeFile(srcDir, 'Default/Cookies', 'cookie-jar-contents');
    await writeFile(srcDir, 'Default/Local Storage/leveldb/000003.log', 'ls-data');
    await writeFile(srcDir, 'Local State', '{"os_crypt":{}}');

    const put = capturingPut(204);
    const snap = await snapshotContext(
      { uploadUrl: 'http://runtime/snap', projectId: 'proj_a' },
      srcDir,
      { fetchImpl: put.fetchImpl, masterKey: MASTER, maxBytes: BIG },
    );
    expect(snap.ok).toBe(true);
    expect(put.captured.body).not.toBeNull();

    const load = await loadContext({ loadUrl: 'http://runtime/dl', projectId: 'proj_a' }, dstDir, {
      fetchImpl: returningGet(put.captured.body),
      masterKey: MASTER,
    });
    expect(load.loaded).toBe(true);

    expect(await readFileOrNull(dstDir, 'Default/Cookies')).toBe('cookie-jar-contents');
    expect(await readFileOrNull(dstDir, 'Default/Local Storage/leveldb/000003.log')).toBe(
      'ls-data',
    );
    expect(await readFileOrNull(dstDir, 'Local State')).toBe('{"os_crypt":{}}');
  });

  it('excludes cache dirs from the snapshot', async () => {
    await writeFile(srcDir, 'Default/Cookies', 'keep-me');
    await writeFile(srcDir, 'Default/Cache/data_0', 'discard-me');
    await writeFile(srcDir, 'Default/Code Cache/js/x', 'discard-me-too');
    await writeFile(srcDir, 'ShaderCache/GPUCache/y', 'discard');

    const put = capturingPut(204);
    await snapshotContext({ uploadUrl: 'http://runtime/snap', projectId: 'proj_a' }, srcDir, {
      fetchImpl: put.fetchImpl,
      masterKey: MASTER,
      maxBytes: BIG,
    });
    await loadContext({ loadUrl: 'http://runtime/dl', projectId: 'proj_a' }, dstDir, {
      fetchImpl: returningGet(put.captured.body),
      masterKey: MASTER,
    });

    expect(await readFileOrNull(dstDir, 'Default/Cookies')).toBe('keep-me');
    expect(await readFileOrNull(dstDir, 'Default/Cache/data_0')).toBeNull();
    expect(await readFileOrNull(dstDir, 'Default/Code Cache/js/x')).toBeNull();
    expect(await readFileOrNull(dstDir, 'ShaderCache/GPUCache/y')).toBeNull();
  });

  it('cross-project key cannot decrypt (auth failure on load)', async () => {
    await writeFile(srcDir, 'Default/Cookies', 'secret');
    const put = capturingPut(204);
    await snapshotContext({ uploadUrl: 'http://runtime/snap', projectId: 'proj_a' }, srcDir, {
      fetchImpl: put.fetchImpl,
      masterKey: MASTER,
      maxBytes: BIG,
    });
    // load as a DIFFERENT project → derived key differs → GCM auth fails
    await expect(
      loadContext({ loadUrl: 'http://runtime/dl', projectId: 'proj_b' }, dstDir, {
        fetchImpl: returningGet(put.captured.body),
        masterKey: MASTER,
      }),
    ).rejects.toThrow();
  });
});

describe('loadContext failure / edge paths', () => {
  it('404 → { loaded: false }, dst untouched', async () => {
    const res = await loadContext({ loadUrl: 'http://runtime/dl', projectId: 'proj_a' }, dstDir, {
      fetchImpl: returningGet(null, 404),
      masterKey: MASTER,
    });
    expect(res.loaded).toBe(false);
    expect(await fs.readdir(dstDir)).toHaveLength(0);
  });

  it('non-404 error status → throws', async () => {
    await expect(
      loadContext({ loadUrl: 'http://runtime/dl', projectId: 'proj_a' }, dstDir, {
        fetchImpl: returningGet(null, 500),
        masterKey: MASTER,
      }),
    ).rejects.toThrow(/status 500/);
  });

  it('no master key → throws', async () => {
    await expect(
      loadContext({ loadUrl: 'http://runtime/dl', projectId: 'proj_a' }, dstDir, {
        fetchImpl: returningGet(Buffer.alloc(64), 200),
        masterKey: '',
      }),
    ).rejects.toThrow(/MASTER_KEY/);
  });
});

describe('snapshotContext failure / edge paths (never throws)', () => {
  it('no master key → { ok:false, reason:no_master_key }, no PUT', async () => {
    await writeFile(srcDir, 'Default/Cookies', 'x');
    const put = capturingPut(204);
    const res = await snapshotContext(
      { uploadUrl: 'http://runtime/snap', projectId: 'proj_a' },
      srcDir,
      { fetchImpl: put.fetchImpl, masterKey: '', maxBytes: BIG },
    );
    expect(res).toEqual({ ok: false, reason: 'no_master_key' });
    expect(put.captured.body).toBeNull();
  });

  it('oversize blob → { ok:false, reason:too_large }, no PUT', async () => {
    await writeFile(srcDir, 'Default/Cookies', 'some content that compresses to > 1 byte');
    const put = capturingPut(204);
    const res = await snapshotContext(
      { uploadUrl: 'http://runtime/snap', projectId: 'proj_a' },
      srcDir,
      { fetchImpl: put.fetchImpl, masterKey: MASTER, maxBytes: 1 },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('too_large');
    expect(put.captured.body).toBeNull(); // never attempted upload
  });

  it('cloud-runtime 413 → { ok:false, reason:rejected_413 }', async () => {
    await writeFile(srcDir, 'Default/Cookies', 'x');
    const put = capturingPut(413);
    const res = await snapshotContext(
      { uploadUrl: 'http://runtime/snap', projectId: 'proj_a' },
      srcDir,
      { fetchImpl: put.fetchImpl, masterKey: MASTER, maxBytes: BIG },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('rejected_413');
  });

  it('network error during PUT → { ok:false, reason:error } (no throw)', async () => {
    await writeFile(srcDir, 'Default/Cookies', 'x');
    const failingFetch = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const res = await snapshotContext(
      { uploadUrl: 'http://runtime/snap', projectId: 'proj_a' },
      srcDir,
      { fetchImpl: failingFetch, masterKey: MASTER, maxBytes: BIG },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('error');
  });

  it('encrypted blob is decryptable with the matching project key (wire-format sanity)', async () => {
    await writeFile(srcDir, 'Default/Cookies', 'verify-wire-format');
    const put = capturingPut(204);
    await snapshotContext({ uploadUrl: 'http://runtime/snap', projectId: 'proj_a' }, srcDir, {
      fetchImpl: put.fetchImpl,
      masterKey: MASTER,
      maxBytes: BIG,
    });
    const key = deriveKey(MASTER, 'proj_a');
    // decrypt → gzipped tar; we only assert it decrypts + has gzip magic (0x1f 0x8b)
    const tarball = decryptBlob(put.captured.body!, key);
    expect(tarball[0]).toBe(0x1f);
    expect(tarball[1]).toBe(0x8b);
  });
});
