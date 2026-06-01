/**
 * Phase 11.6 — Context blob 存储后端抽象。
 *
 * 同 `MachineManager` interface 套路：phase 11.6a 仅一个 `FsContextStorage` 实现
 * 落 fly volume `/data/contexts/`；phase 11.6b 加 `S3ContextStorage` / `R2ContextStorage`
 * 时，调用方（routes/contexts.ts、routes/_internal-contexts.ts）不需要变。
 *
 * Streaming API：read/write 都用 Node Stream，避免 100MB blob 吃满进程内存。
 *
 * Wire format inside the blob = `[nonce(12)][tag(16)][ciphertext]`（见
 * utils/crypto.ts）—— storage backend 只看作 opaque bytes，加解密在调用方
 * （routes/_internal-contexts.ts）做。
 */

import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getLogger } from '../utils/logger.js';

export interface ContextStorage {
  /**
   * Open a read stream for the blob at `key`. Caller pipes it into the HTTP
   * response or into decryption + decompression.
   *
   * @returns null 如果不存在（caller 翻成 404）；否则一个 Readable
   */
  read(key: string): Promise<Readable | null>;

  /**
   * Write a blob to `key`, atomically replacing any existing content.
   * Implementations should write to a temp path and rename to avoid torn
   * reads if a snapshot is uploaded while another session is reading.
   *
   * @returns 写入的字节数（用于更新 contexts.bytes 列）
   */
  write(key: string, data: Readable): Promise<number>;

  /**
   * Hard-delete the blob. Idempotent — missing key is OK.
   * Phase 11.6a 不调用（DELETE /v1/contexts 仅 soft-delete DB row）；
   * 11.6b GC job 用。
   */
  delete(key: string): Promise<void>;

  /** 询问 blob 是否存在 + 多大字节。null = 不存在。 */
  stat(key: string): Promise<{ bytes: number } | null>;
}

/**
 * 文件系统后端 —— 写到 `${rootPath}/${key}`。
 *
 * 关键安全：拒绝 `key` 含 `..` 或绝对路径前缀，防止 caller 拿到 `routes/contexts.ts`
 * 的 storageKey 字段后通过 `'../../../etc/passwd'` 越权读宿主机文件。Phase 11.6a
 * 调用方 storageKey 由 cloud-runtime 自己生成（`${ctxId}.tar.zst.enc`），不应包含
 * `..`，但 defense in depth 一定要做。
 */
export class FsContextStorage implements ContextStorage {
  readonly rootPath: string;
  readonly #log = getLogger();

  constructor(rootPath: string) {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`FsContextStorage rootPath must be absolute, got: ${rootPath}`);
    }
    this.rootPath = path.resolve(rootPath); // normalize
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootPath, { recursive: true });
  }

  /**
   * Resolve `key` to absolute path under rootPath, validating no traversal.
   * Throws on attempted `..` or absolute key.
   */
  #resolveKey(key: string): string {
    if (key.length === 0) throw new Error('storage key empty');
    // Reject explicit traversal markers and any absolute prefix. We intentionally
    // do NOT just use path.resolve() result-checking because Node's path.resolve
    // collapses `..` and might silently allow `foo/../bar` which resolves inside
    // rootPath but indicates a buggy caller. Reject any key containing `..` to
    // surface bugs early.
    if (key.includes('..')) {
      throw new Error(`storage key contains traversal: ${key}`);
    }
    if (path.isAbsolute(key)) {
      throw new Error(`storage key must be relative, got absolute: ${key}`);
    }
    const resolved = path.resolve(this.rootPath, key);
    // Final check: resolved path must still live under rootPath (defense-in-depth
    // against unicode normalization tricks etc.).
    if (!resolved.startsWith(this.rootPath + path.sep) && resolved !== this.rootPath) {
      throw new Error(`storage key resolved outside rootPath: ${key} → ${resolved}`);
    }
    return resolved;
  }

  async read(key: string): Promise<Readable | null> {
    const full = this.#resolveKey(key);
    try {
      // Probe existence first so we can return null cleanly. createReadStream
      // would also throw on missing, but we want a typed "not found" path.
      await fs.access(full);
    } catch {
      return null;
    }
    return createReadStream(full);
  }

  async write(key: string, data: Readable): Promise<number> {
    const full = this.#resolveKey(key);
    await fs.mkdir(path.dirname(full), { recursive: true });

    // Atomic write: stream to `${full}.tmp.${pid}.${rand}`, then rename. This
    // avoids torn reads if an in-flight read is happening on `full` while a
    // snapshot upload races to overwrite. Linux `rename(2)` is atomic on the
    // same filesystem, which fly volumes guarantee.
    const tmpPath = `${full}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    const writeStream = createWriteStream(tmpPath);
    let bytes = 0;
    data.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    try {
      await pipeline(data, writeStream);
      await fs.rename(tmpPath, full);
      this.#log.debug({ key, bytes }, 'context storage: wrote blob');
      return bytes;
    } catch (err) {
      // Clean up tmp on failure (best effort; if this fails too, leave the
      // crumb — ops can sweep `*.tmp.*` later).
      await fs.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const full = this.#resolveKey(key);
    await fs.unlink(full).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return; // idempotent
      throw err;
    });
  }

  async stat(key: string): Promise<{ bytes: number } | null> {
    const full = this.#resolveKey(key);
    try {
      const s = await fs.stat(full);
      return { bytes: s.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

// ─── factory + singleton ────────────────────────────────────────────────────

let cached: ContextStorage | null = null;

/**
 * Phase 11.6a 工厂：仅返回 FsContextStorage（按 MOSAIQ_CONTEXT_STORAGE_PATH）。
 * Phase 11.6b 时按 env switch 选 fs / s3。
 *
 * Caller pattern: `getContextStorage()` lazily builds + caches; `disposeContextStorage()`
 * 单测 + reload 用。
 */
export async function getContextStorage(rootPath: string): Promise<ContextStorage> {
  if (cached) return cached;
  const fs = new FsContextStorage(rootPath);
  await fs.ensureRoot();
  cached = fs;
  return cached;
}

export function disposeContextStorage(): void {
  cached = null;
}

/** 测试用：直接注入 mock storage。 */
export function setContextStorageForTesting(storage: ContextStorage | null): void {
  cached = storage;
}
