/**
 * Phase 11.6 — context blob 对称加密 helper（pod 侧）。
 *
 * ⚠️  WIRE-FORMAT MIRROR：本文件与 `apps/cloud-runtime/src/utils/crypto.ts` 的
 *     deriveKey / encryptBlob / decryptBlob **必须逐字节一致**。cloud-runtime 落盘
 *     的 blob 由 pod 解密，pod 上传的 blob 由 cloud-runtime 原样存储——两边对
 *     wire format 的任何分歧都会导致 GCM auth 失败 / 解密乱码。改一边务必同步另一边。
 *
 * Wire format（GET 下载 / PUT 上传 的字节布局）：
 *
 *   [ nonce(12) ][ tag(16) ][ ciphertext(N) ]
 *
 * 加密：AES-256-GCM with per-project 32-byte key：
 *
 *   project_key = HKDF-SHA256(master, salt=projectId, info='mosaiq-ctx-v1', 32)
 *
 * pod 不持有 HMAC token secret（那是 cloud-runtime 用来签 URL 的）；pod 只拿
 * pre-signed URL + master key（POD_CONTEXT_MASTER_KEY，与 cloud-runtime 的
 * MOSAIQ_CONTEXT_MASTER_KEY 同源 fly secret）派生 per-project key。
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // AES-256
const NONCE_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM auth tag
const HKDF_INFO = Buffer.from('mosaiq-ctx-v1', 'utf8');

/**
 * 从 base64 master key + projectId 派生 32-byte AES key。
 *
 * @throws 如果 masterKeyBase64 解码后非 32 bytes
 */
export function deriveKey(masterKeyBase64: string, projectId: string): Buffer {
  const master = Buffer.from(masterKeyBase64, 'base64');
  if (master.length !== KEY_LEN) {
    throw new Error(
      `POD_CONTEXT_MASTER_KEY decoded to ${master.length} bytes, expected ${KEY_LEN}`,
    );
  }
  const salt = Buffer.from(projectId, 'utf8');
  const out = hkdfSync('sha256', master, salt, HKDF_INFO, KEY_LEN);
  return Buffer.from(out);
}

export interface EncryptedBlob {
  /** 完整 [nonce][tag][ciphertext] —— PUT body 直接写这个。 */
  blob: Buffer;
  /** nonce hex（仅 ops/log 用）。 */
  nonceHex: string;
}

/** Encrypt plaintext（已压缩的 tarball）→ wire-format blob。 */
export function encryptBlob(plaintext: Buffer, key: Buffer): EncryptedBlob {
  if (key.length !== KEY_LEN) {
    throw new Error(`encrypt: key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([nonce, tag, ciphertext]);
  return { blob, nonceHex: nonce.toString('hex') };
}

/**
 * Decrypt wire-format blob → plaintext。GCM auth tag 校验：篡改任意字节都抛错。
 *
 * @throws Error 如果 blob 长度不足，或 GCM verify 失败（跨 master key / 损坏）。
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
