/**
 * 加密哈希辅助。
 *
 * API key 在 DB 只存 sha256(plaintext)，明文只在创建时返回一次。这跟 Stripe
 * 的做法一致：服务端永远拿不到原 token，泄漏 DB 不等于泄漏 key。
 */

import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
