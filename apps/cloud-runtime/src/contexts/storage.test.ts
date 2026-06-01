import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsContextStorage, disposeContextStorage } from './storage.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaiq-ctx-store-'));
});

afterEach(async () => {
  disposeContextStorage();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const bufStream = (b: Buffer): Readable => Readable.from([b]);

describe('FsContextStorage', () => {
  it('write + read round-trip preserves bytes', async () => {
    const store = new FsContextStorage(tmpRoot);
    await store.ensureRoot();

    const payload = Buffer.from('hello phase 11.6 contexts');
    const bytes = await store.write('ctx_abc.tar.zst.enc', bufStream(payload));
    expect(bytes).toBe(payload.length);

    const stream = await store.read('ctx_abc.tar.zst.enc');
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of stream!) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it('read of missing key returns null', async () => {
    const store = new FsContextStorage(tmpRoot);
    await store.ensureRoot();
    expect(await store.read('ctx_nonexistent.tar.zst.enc')).toBeNull();
  });

  it('stat returns size for existing, null for missing', async () => {
    const store = new FsContextStorage(tmpRoot);
    await store.ensureRoot();
    await store.write('ctx_x.bin', bufStream(Buffer.alloc(123)));
    expect(await store.stat('ctx_x.bin')).toEqual({ bytes: 123 });
    expect(await store.stat('ctx_missing.bin')).toBeNull();
  });

  it('write to existing key atomically replaces (no torn reads)', async () => {
    const store = new FsContextStorage(tmpRoot);
    await store.ensureRoot();
    await store.write('ctx_x.bin', bufStream(Buffer.from('v1 contents'.repeat(100))));
    await store.write('ctx_x.bin', bufStream(Buffer.from('v2 contents'.repeat(100))));

    const s = await store.read('ctx_x.bin');
    const chunks: Buffer[] = [];
    for await (const c of s!) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('v2 contents'.repeat(100));

    // No leftover .tmp files in the storage dir
    const entries = await fs.readdir(tmpRoot);
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('delete is idempotent (no error on missing)', async () => {
    const store = new FsContextStorage(tmpRoot);
    await store.ensureRoot();
    await store.delete('ctx_never_existed.bin'); // should not throw
    await store.write('ctx_y.bin', bufStream(Buffer.from('to-delete')));
    await store.delete('ctx_y.bin');
    expect(await store.stat('ctx_y.bin')).toBeNull();
  });

  it('rejects key with .. traversal', async () => {
    const store = new FsContextStorage(tmpRoot);
    await store.ensureRoot();
    await expect(store.read('../etc/passwd')).rejects.toThrow(/traversal/);
    await expect(store.write('../leak.bin', bufStream(Buffer.from('x')))).rejects.toThrow(
      /traversal/,
    );
    await expect(store.stat('foo/../../bar')).rejects.toThrow(/traversal/);
  });

  it('rejects absolute key', async () => {
    const store = new FsContextStorage(tmpRoot);
    await store.ensureRoot();
    // Use a path that's absolute on either OS (Windows uses backslash, but
    // forward-slash absolute is also rejected by the isAbsolute check)
    const absKey = process.platform === 'win32' ? 'C:\\evil.bin' : '/etc/passwd';
    await expect(store.read(absKey)).rejects.toThrow(/absolute/);
  });

  it('constructor rejects non-absolute rootPath', () => {
    expect(() => new FsContextStorage('relative/path')).toThrow(/must be absolute/);
  });
});
