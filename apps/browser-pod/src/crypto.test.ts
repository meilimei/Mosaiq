/**
 * Phase 11.6 — pod 侧 crypto helper 单测。
 *
 * 关键不变量：与 cloud-runtime 的 crypto wire format 一致。本测试单测 pod 侧实现；
 * cross-impl 一致性由 context-io 的 round-trip + cloud-runtime 的 internal-contexts
 * 测试覆盖（同 master key 派生同 key）。
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { decryptBlob, deriveKey, encryptBlob } from './crypto.js';

const MASTER = randomBytes(32).toString('base64');

describe('deriveKey', () => {
  it('deterministic: same master+project → same key', () => {
    const a = deriveKey(MASTER, 'proj_x');
    const b = deriveKey(MASTER, 'proj_x');
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it('different project → different key', () => {
    const a = deriveKey(MASTER, 'proj_x');
    const b = deriveKey(MASTER, 'proj_y');
    expect(a.equals(b)).toBe(false);
  });

  it('rejects master key of wrong decoded length', () => {
    const short = Buffer.from('too-short').toString('base64');
    expect(() => deriveKey(short, 'proj_x')).toThrow(/expected 32/);
  });
});

describe('encryptBlob / decryptBlob round-trip', () => {
  it('round-trips arbitrary bytes', () => {
    const key = deriveKey(MASTER, 'proj_x');
    const plain = randomBytes(4096);
    const { blob, nonceHex } = encryptBlob(plain, key);
    // wire format: [nonce(12)][tag(16)][ciphertext]
    expect(blob.length).toBe(12 + 16 + plain.length);
    expect(nonceHex).toHaveLength(24); // 12 bytes hex
    const back = decryptBlob(blob, key);
    expect(back.equals(plain)).toBe(true);
  });

  it('empty plaintext round-trips', () => {
    const key = deriveKey(MASTER, 'proj_x');
    const { blob } = encryptBlob(Buffer.alloc(0), key);
    expect(decryptBlob(blob, key).length).toBe(0);
  });

  it('nonce is random per call (two encrypts differ)', () => {
    const key = deriveKey(MASTER, 'proj_x');
    const p = Buffer.from('same input');
    const a = encryptBlob(p, key).blob;
    const b = encryptBlob(p, key).blob;
    expect(a.equals(b)).toBe(false);
  });
});

describe('decryptBlob failure modes', () => {
  it('wrong project key → auth failure', () => {
    const keyA = deriveKey(MASTER, 'proj_a');
    const keyB = deriveKey(MASTER, 'proj_b');
    const { blob } = encryptBlob(randomBytes(256), keyA);
    expect(() => decryptBlob(blob, keyB)).toThrow();
  });

  it('tampered ciphertext → auth failure', () => {
    const key = deriveKey(MASTER, 'proj_x');
    const { blob } = encryptBlob(randomBytes(256), key);
    // flip a byte in the ciphertext region (after nonce+tag)
    blob[40] = blob[40]! ^ 0xff;
    expect(() => decryptBlob(blob, key)).toThrow();
  });

  it('tampered nonce → auth failure', () => {
    const key = deriveKey(MASTER, 'proj_x');
    const { blob } = encryptBlob(randomBytes(256), key);
    blob[0] = blob[0]! ^ 0xff;
    expect(() => decryptBlob(blob, key)).toThrow();
  });

  it('blob too short → throws length error', () => {
    const key = deriveKey(MASTER, 'proj_x');
    expect(() => decryptBlob(Buffer.alloc(10), key)).toThrow(/too short/);
  });
});
