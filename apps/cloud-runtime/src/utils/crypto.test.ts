import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decryptBlob,
  deriveKey,
  encryptBlob,
  signInternalToken,
  verifyInternalToken,
} from './crypto.js';

const masterKey = randomBytes(32).toString('base64');

describe('deriveKey', () => {
  it('same (master, projectId) → same derived key', () => {
    const a = deriveKey(masterKey, 'proj_x');
    const b = deriveKey(masterKey, 'proj_x');
    expect(a.equals(b)).toBe(true);
  });

  it('different projectId → different key (HKDF salt does its job)', () => {
    const a = deriveKey(masterKey, 'proj_a');
    const b = deriveKey(masterKey, 'proj_b');
    expect(a.equals(b)).toBe(false);
  });

  it('different master → different key', () => {
    const otherMaster = randomBytes(32).toString('base64');
    const a = deriveKey(masterKey, 'proj_x');
    const b = deriveKey(otherMaster, 'proj_x');
    expect(a.equals(b)).toBe(false);
  });

  it('master not 32 bytes → throws', () => {
    const short = Buffer.alloc(16).toString('base64');
    expect(() => deriveKey(short, 'proj_x')).toThrow(/expected 32/);
  });
});

describe('encryptBlob / decryptBlob round-trip', () => {
  it('plaintext → ciphertext → plaintext', () => {
    const key = deriveKey(masterKey, 'proj_x');
    const plaintext = Buffer.from('hello phase 11.6 contexts world', 'utf8');
    const { blob, nonceHex } = encryptBlob(plaintext, key);
    expect(nonceHex).toMatch(/^[0-9a-f]{24}$/); // 12 bytes hex
    expect(blob.length).toBeGreaterThan(plaintext.length); // includes nonce + tag
    const decrypted = decryptBlob(blob, key);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('large plaintext (5MB simulated context tarball)', () => {
    const key = deriveKey(masterKey, 'proj_x');
    const plaintext = randomBytes(5 * 1024 * 1024);
    const { blob } = encryptBlob(plaintext, key);
    const decrypted = decryptBlob(blob, key);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('two encrypts of same plaintext produce different blobs (random nonce)', () => {
    const key = deriveKey(masterKey, 'proj_x');
    const plaintext = Buffer.from('same input', 'utf8');
    const a = encryptBlob(plaintext, key);
    const b = encryptBlob(plaintext, key);
    expect(a.blob.equals(b.blob)).toBe(false);
    expect(a.nonceHex).not.toEqual(b.nonceHex);
  });

  it('decrypt with wrong key (different projectId) → throws GCM auth error', () => {
    const k1 = deriveKey(masterKey, 'proj_a');
    const k2 = deriveKey(masterKey, 'proj_b');
    const plaintext = Buffer.from('secret', 'utf8');
    const { blob } = encryptBlob(plaintext, k1);
    expect(() => decryptBlob(blob, k2)).toThrow();
  });

  it('decrypt of tampered blob (single byte flipped) → throws GCM auth error', () => {
    const key = deriveKey(masterKey, 'proj_x');
    const { blob } = encryptBlob(Buffer.from('integrity check', 'utf8'), key);
    // flip a byte in the ciphertext (after nonce+tag = byte 28+)
    const tampered = Buffer.from(blob);
    tampered[40] = tampered[40]! ^ 0x01;
    expect(() => decryptBlob(tampered, key)).toThrow();
  });

  it('decrypt of truncated blob → throws "too short"', () => {
    const key = deriveKey(masterKey, 'proj_x');
    const tooShort = Buffer.alloc(10);
    expect(() => decryptBlob(tooShort, key)).toThrow(/too short/);
  });
});

describe('signInternalToken / verifyInternalToken', () => {
  const secret = 'a'.repeat(64);

  it('happy path: sign → verify → ok', () => {
    const token = signInternalToken(secret, 'ctx_abc', 'download');
    const result = verifyInternalToken(token, secret, 'ctx_abc', 'download');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  it('verify with wrong ctxId → bad_signature', () => {
    const token = signInternalToken(secret, 'ctx_abc', 'download');
    const result = verifyInternalToken(token, secret, 'ctx_xyz', 'download');
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('verify with wrong op (download vs snapshot) → bad_signature', () => {
    const token = signInternalToken(secret, 'ctx_abc', 'download');
    const result = verifyInternalToken(token, secret, 'ctx_abc', 'snapshot');
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('verify with wrong secret → bad_signature', () => {
    const token = signInternalToken(secret, 'ctx_abc', 'download');
    const result = verifyInternalToken(token, 'b'.repeat(64), 'ctx_abc', 'download');
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('verify expired token → expired', () => {
    // Sign at t=0, verify at t = 5min + 1s later
    const token = signInternalToken(secret, 'ctx_abc', 'download', 0);
    const result = verifyInternalToken(token, secret, 'ctx_abc', 'download', 5 * 60 * 1000 + 1000);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('verify malformed token (wrong number of dots) → malformed', () => {
    expect(verifyInternalToken('not.a.valid.token', secret, 'ctx', 'download')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyInternalToken('twoparts', secret, 'ctx', 'download')).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('verify wrong version prefix → wrong_version', () => {
    const result = verifyInternalToken('v99.1234567890.deadbeef', secret, 'ctx_abc', 'download');
    expect(result).toEqual({ ok: false, reason: 'wrong_version' });
  });
});
