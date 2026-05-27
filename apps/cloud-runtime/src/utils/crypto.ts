/**
 * Phase 11.6 — context blob 的对称加密 helper。
 *
 * Wire format（落盘 / 流式 PUT 的字节布局）：
 *
 *   [ nonce(12) ][ tag(16) ][ ciphertext(N) ]
 *
 * 单文件无外部 metadata —— nonce 写在 blob 头，能直接独立解密；契合 phase 11.6
 * design §6.5 "存盘格式：[nonce][tag][ciphertext]，单文件无需外部 metadata"。
 *
 * 加密：AES-256-GCM with **per-project** 32-byte key derived from master key:
 *
 *   project_key = HKDF-SHA256(master, salt=projectId, info='mosaiq-ctx-v1', 32 bytes)
 *
 * Salt = projectId 让"同 master，不同 project"的 ciphertext 完全无关——即使
 * 两个 project 上传同一份明文，密文也是不同的，且彼此 key 不能解开对方。
 *
 * info='mosaiq-ctx-v1' 是 protocol version label：phase 11.6c 旋转时改成 -v2
 * 让新老 row 在共享 master 时不撞 key（schema.ts 的 `enc_algo='aes-256-gcm-v1'`
 * 与之对应）。
 *
 * 不用 KDF iterations（如 PBKDF2）的理由：master key 本身就是 cryptographically
 * random 32 bytes（`openssl rand -base64 32`），不存在低熵 password 暴破问题，
 * HKDF 是 fast key derivation function 的正确选择。
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // AES-256
const NONCE_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM auth tag
const HKDF_INFO = Buffer.from('mosaiq-ctx-v1', 'utf8');

/**
 * 从 base64 master key + projectId 派生一份 32-byte AES key。
 *
 * 调用方应当**只**保留 derived key 的内存周期到一次 encrypt/decrypt 操作完成；
 * 不要长期 cache 派生 key（master 旋转后 cache 命中会用旧 key 解密最新 blob）。
 *
 * @throws if masterKeyBase64 解码后非 32 bytes（与 env.ts 长度校验互补，启动时
 * 已经过一道 z.string().min(40) 拦截，这里抛错只兜底 base64 含损坏字符的场景）
 */
export function deriveKey(masterKeyBase64: string, projectId: string): Buffer {
  const master = Buffer.from(masterKeyBase64, 'base64');
  if (master.length !== KEY_LEN) {
    throw new Error(
      `MOSAIQ_CONTEXT_MASTER_KEY decoded to ${master.length} bytes, expected ${KEY_LEN}`,
    );
  }
  const salt = Buffer.from(projectId, 'utf8');
  // hkdfSync returns ArrayBuffer — wrap to Buffer for consistent downstream API.
  const out = hkdfSync('sha256', master, salt, HKDF_INFO, KEY_LEN);
  return Buffer.from(out);
}

export interface EncryptedBlob {
  /** 完整的 [nonce][tag][ciphertext] 字节流。落盘 / PUT 直接写这个 buffer。 */
  blob: Buffer;
  /** 仅 nonce（hex string），便于落 contexts.enc_nonce 列做 ops 验证。 */
  nonceHex: string;
}

/**
 * Encrypt + 包装成 wire-format blob。
 *
 * @param plaintext context tarball（已 zstd 压缩过的 bytes）
 * @param key       deriveKey() 派生的 32-byte AES key
 * @returns         可直接落盘的 blob + nonceHex（写 contexts.enc_nonce 列）
 */
export function encryptBlob(plaintext: Buffer, key: Buffer): EncryptedBlob {
  if (key.length !== KEY_LEN) {
    throw new Error(`encrypt: key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes for GCM

  // Wire format: nonce | tag | ciphertext
  const blob = Buffer.concat([nonce, tag, ciphertext]);
  return { blob, nonceHex: nonce.toString('hex') };
}

/**
 * Decrypt wire-format blob → plaintext bytes。
 *
 * 自动校验 GCM auth tag —— 篡改任意 byte（包括 nonce / tag / ciphertext）都会
 * 抛 'Unsupported state or unable to authenticate data'，调用方按此 catch 视为
 * "context 损坏 / 跨 master key" 错误处理。
 *
 * @throws Error 'invalid blob length' 如果 buffer < nonce+tag 长度
 * @throws crypto auth error 如果 GCM verify 失败
 */
export function decryptBlob(blob: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new Error(`decrypt: key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new Error(`decrypt: blob too short (${blob.length} bytes)`);
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ciphertext = blob.subarray(NONCE_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ─── HMAC for internal endpoint signing (cloud-runtime ↔ pod) ──────────────
//
// Pod GET /v1/_internal/contexts/{id}/download?token=<base64url>。Token = HMAC
// over `${ctxId}|${op}|${expiresAtUnix}` with MOSAIQ_INTERNAL_HMAC_SECRET。
// Verify 端 timingSafeEqual 防 timing attack。
//
// **Critical**：HMAC secret 与 master key 是分离的（design §3 decision 2 +
// §8 risk row 5）；两个 secret 同时被攻破才致命。

import { createHmac } from 'node:crypto';

const TOKEN_VERSION = 'v1';
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * 签 internal endpoint token。Output 格式：
 *
 *   `${TOKEN_VERSION}.${expiresAtUnix}.${hmacHex}`
 *
 * 单 string，作为 query param `?token=` 直接传。
 */
export function signInternalToken(
  hmacSecret: string,
  ctxId: string,
  op: 'download' | 'snapshot',
  nowMs: number = Date.now(),
): string {
  const expiresAt = Math.floor((nowMs + TOKEN_TTL_MS) / 1000);
  const payload = `${TOKEN_VERSION}|${ctxId}|${op}|${expiresAt}`;
  const hmac = createHmac('sha256', hmacSecret).update(payload).digest('hex');
  return `${TOKEN_VERSION}.${expiresAt}.${hmac}`;
}

export type VerifyResult =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: 'malformed' | 'wrong_version' | 'expired' | 'bad_signature' };

/**
 * 校验 token 对 (ctxId, op) 是否有效。timingSafeEqual 比较签名防止 attacker
 * 通过测量响应时间 brute-force 字节。
 */
export function verifyInternalToken(
  token: string,
  hmacSecret: string,
  ctxId: string,
  op: 'download' | 'snapshot',
  nowMs: number = Date.now(),
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, expiresAtStr, sig] = parts;
  if (version !== TOKEN_VERSION) return { ok: false, reason: 'wrong_version' };
  const expiresAt = Number(expiresAtStr);
  if (!Number.isInteger(expiresAt)) return { ok: false, reason: 'malformed' };
  if (expiresAt * 1000 < nowMs) return { ok: false, reason: 'expired' };

  const payload = `${TOKEN_VERSION}|${ctxId}|${op}|${expiresAt}`;
  const expectHex = createHmac('sha256', hmacSecret).update(payload).digest('hex');
  // timingSafeEqual 要求两 buffer 等长；先 length check 早返。
  if (sig?.length !== expectHex.length) return { ok: false, reason: 'bad_signature' };
  const a = Buffer.from(sig!, 'hex');
  const b = Buffer.from(expectHex, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, expiresAt };
}
