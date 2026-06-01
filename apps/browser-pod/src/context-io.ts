/**
 * Phase 11.6 — pod 侧 context I/O：load（启动前装载）+ snapshot（关闭前回写）。
 *
 *   loadContext:     GET signed URL → decrypt → gunzip+untar 进 user-data-dir
 *   snapshotContext: tar+gzip user-data-dir → encrypt → size-check → PUT signed URL
 *
 * 归档用系统 `tar` 子进程 + gzip（`-czf -` / `-xzf -`）。理由：
 *   - pod 镜像本就装了 tar（Dockerfile），不引入 npm 依赖 + @types
 *   - GNU tar（Linux 生产/CI）与 bsdtar（Windows/macOS dev）都支持 `-czf -` /
 *     `-xzf -` / `--exclude=`，跨平台一致
 *   - 压缩用 gzip 而非 design 原写的 zstd：gzip 在所有 tar 实现里都内建，zstd 需
 *     额外 `--zstd` flag + 二进制（GNU tar ≥1.31），可用性不保证。blob 对 cloud-runtime
 *     完全不透明（它只存字节 + 抽头部 nonce），pod 是唯一压/解方，所以算法纯属
 *     pod 内部细节，gzip 完全够用（典型 profile 5–50MB，gzip/zstd 解压差异 < 100ms）。
 *     storage_key 后缀 `.tar.zst.enc` 是 cosmetic，不影响正确性。
 *
 * snapshot 错误隔离：snapshotContext **永不抛**——失败返回 result 对象，让
 * killChromium 继续完成 chromium 销毁 + user-data-dir 清理（design §6.4）。
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { Logger } from 'pino';

import { decryptBlob, deriveKey, encryptBlob } from './crypto.js';
import { loadEnv } from './env.js';
import { getLogger } from './logger.js';

/**
 * chromium user-data-dir 里纯缓存 / 可重建的目录——snapshot 时排除，省体积 + 不
 * 含任何用户登录态。路径相对 user-data-dir 根（`-C dir .` 模式下以 `./` 开头）。
 */
const SNAPSHOT_EXCLUDES = [
  './Default/Cache',
  './Default/Code Cache',
  './Default/GPUCache',
  './Default/DawnGraphiteCache',
  './Default/DawnWebGPUCache',
  './Default/Service Worker/CacheStorage',
  './Default/Service Worker/ScriptCache',
  './GrShaderCache',
  './ShaderCache',
  './GraphiteDawnCache',
  './component_crx_cache',
  './extensions_crx_cache',
];

/** tar 二进制路径，可用 POD_TAR_BIN 覆盖（测试 / 非标准镜像）。 */
function tarBin(): string {
  return process.env.POD_TAR_BIN || 'tar';
}

export interface ContextLoadInput {
  /** cloud-runtime 签的下载 URL（含 ?token=）。 */
  loadUrl: string;
  /** AES key 派生用 project id。 */
  projectId: string;
}

export interface ContextSnapshotInput {
  /** cloud-runtime 签的上传 URL（含 ?token=）。 */
  uploadUrl: string;
  projectId: string;
}

export interface ContextIoDeps {
  fetchImpl?: typeof fetch;
  /** base64 master key；默认读 env POD_CONTEXT_MASTER_KEY。 */
  masterKey?: string;
  /** snapshot 大小上限（bytes）；默认 env POD_CONTEXT_SIZE_MAX_MB。 */
  maxBytes?: number;
  logger?: Logger;
}

export interface SnapshotResult {
  ok: boolean;
  /** 失败 / skip 原因。 */
  reason?: 'no_master_key' | 'too_large' | 'rejected_413' | 'tar_failed' | 'http_error' | 'error';
  /** 加密 blob 字节数（若已算出）。 */
  bytes?: number;
}

// ─── tar 子进程 helpers ──────────────────────────────────────────────────────

/** `tar -czf - -C cwd [--exclude=...] .` → 收集 stdout 为 gzipped tar buffer。 */
function tarCreateGz(cwd: string, excludes: string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // 注意 flag 顺序：options 先于 file 参数（bsdtar 要求 --exclude 在路径前）。
    const args = ['-czf', '-', '-C', cwd];
    for (const ex of excludes) args.push(`--exclude=${ex}`);
    args.push('.');

    const child = spawn(tarBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      // GNU tar 在文件被并发改动时回 exit 1 + "file changed as we read it"——
      // 对 chromium 已退出的 user-data-dir 不该发生，但仍把它当成功（archive 有效）。
      if (code === 0 || code === 1) {
        resolve(Buffer.concat(out));
      } else {
        reject(
          new Error(
            `tar create exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`,
          ),
        );
      }
    });
  });
}

/** `tar -xzf - -C cwd` ← 把 gzipped tar buffer 写进 stdin 解包。 */
function tarExtractGz(cwd: string, gzippedTar: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(tarBin(), ['-xzf', '-', '-C', cwd], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const err: Buffer[] = [];
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `tar extract exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`,
          ),
        );
      }
    });
    child.stdin.on('error', (e) => reject(e));
    child.stdin.end(gzippedTar);
  });
}

// ─── loadContext ─────────────────────────────────────────────────────────────

/**
 * 装载 context 进 user-data-dir。chromium 启动**前**调。
 *
 * - 404 → empty context（从未 snapshot 过），跳过装载走 fresh boot，返回 { loaded:false }
 * - 非 2xx/404 → 抛错（让 spawn 失败：用户期待自己的登录态，静默用空 profile 会
 *   掩盖问题，宁可 loud fail）
 * - decrypt / untar 失败 → 抛错（master key 旋转 / blob 损坏，同样应 loud fail）
 *
 * @returns { loaded } loaded=false 表示空 context（已跳过）
 */
export async function loadContext(
  input: ContextLoadInput,
  userDataDir: string,
  deps: ContextIoDeps = {},
): Promise<{ loaded: boolean }> {
  const log = deps.logger ?? getLogger();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const masterKey = deps.masterKey ?? loadEnv().POD_CONTEXT_MASTER_KEY;
  if (!masterKey) {
    throw new Error('loadContext: POD_CONTEXT_MASTER_KEY not configured');
  }

  const resp = await fetchImpl(input.loadUrl);
  if (resp.status === 404) {
    log.warn({ projectId: input.projectId }, 'context blob 404 — empty context, fresh boot');
    return { loaded: false };
  }
  if (!resp.ok) {
    throw new Error(`loadContext: download failed with status ${resp.status}`);
  }

  const blob = Buffer.from(await resp.arrayBuffer());
  const key = deriveKey(masterKey, input.projectId);
  const tarball = decryptBlob(blob, key); // gunzip 在 tar -xzf 内做

  await mkdir(userDataDir, { recursive: true });
  await tarExtractGz(userDataDir, tarball);
  log.info(
    { projectId: input.projectId, blobBytes: blob.length },
    'context loaded into user-data-dir',
  );
  return { loaded: true };
}

// ─── snapshotContext ───────────────────────────────────────────────────────

/**
 * 把 user-data-dir tar+gzip+encrypt 后 PUT 回 cloud-runtime。chromium 退出**后**、
 * rm user-data-dir **前**调。
 *
 * **永不抛**——任何失败都返回 { ok:false, reason }，由 killChromium 决定（一律
 * 继续清理）。snapshot 失败 = context 停在上次成功版本，cloud-runtime 侧 lock 仍
 * 会被释放（解耦）。
 */
export async function snapshotContext(
  input: ContextSnapshotInput,
  userDataDir: string,
  deps: ContextIoDeps = {},
): Promise<SnapshotResult> {
  const log = deps.logger ?? getLogger();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = loadEnv();
  const masterKey = deps.masterKey ?? env.POD_CONTEXT_MASTER_KEY;
  const maxBytes = deps.maxBytes ?? env.POD_CONTEXT_SIZE_MAX_MB * 1024 * 1024;

  if (!masterKey) {
    log.warn({ projectId: input.projectId }, 'snapshot skipped: no master key');
    return { ok: false, reason: 'no_master_key' };
  }

  let blob: Buffer;
  try {
    const tarball = await tarCreateGz(userDataDir, SNAPSHOT_EXCLUDES);
    const key = deriveKey(masterKey, input.projectId);
    blob = encryptBlob(tarball, key).blob;
  } catch (err) {
    log.warn(
      { projectId: input.projectId, err: err instanceof Error ? err.message : String(err) },
      'snapshot: tar/encrypt failed',
    );
    return { ok: false, reason: 'tar_failed' };
  }

  if (blob.length > maxBytes) {
    // pod 自检：超限就不上传，保留 cloud-runtime 上一版 good blob（design §6.4）。
    log.warn(
      { projectId: input.projectId, bytes: blob.length, maxBytes },
      'snapshot skipped: blob exceeds size limit',
    );
    return { ok: false, reason: 'too_large', bytes: blob.length };
  }

  try {
    const resp = await fetchImpl(input.uploadUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(blob.length),
      },
      body: blob,
    });
    if (resp.status === 204) {
      log.info({ projectId: input.projectId, bytes: blob.length }, 'context snapshot uploaded');
      return { ok: true, bytes: blob.length };
    }
    if (resp.status === 413) {
      log.warn(
        { projectId: input.projectId, bytes: blob.length },
        'snapshot rejected by cloud-runtime (413 too large)',
      );
      return { ok: false, reason: 'rejected_413', bytes: blob.length };
    }
    log.warn(
      { projectId: input.projectId, status: resp.status },
      'snapshot PUT returned unexpected status',
    );
    return { ok: false, reason: 'http_error', bytes: blob.length };
  } catch (err) {
    log.warn(
      { projectId: input.projectId, err: err instanceof Error ? err.message : String(err) },
      'snapshot PUT failed (network)',
    );
    return { ok: false, reason: 'error', bytes: blob.length };
  }
}
