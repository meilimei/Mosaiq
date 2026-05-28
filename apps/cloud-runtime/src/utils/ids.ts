/**
 * 带前缀的 ID 生成（Stripe 风格）。
 *
 * 前缀让 ID 在日志里自带类型信息，调试时一眼能看出是 session / persona / api-key。
 */

import { customAlphabet } from 'nanoid';

// 去除容易混淆的字符 (0/O/1/l/I)。22 字符 ≈ 128bit 熵。
const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const generate22 = customAlphabet(alphabet, 22);
const generate8 = customAlphabet(alphabet, 8);

export type IdPrefix = 'proj' | 'apk' | 'ses' | 'mch' | 'pers' | 'evt' | 'aud' | 'sks' | 'ctx';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${generate22()}`;
}

export function newApiKey(): { plaintext: string; prefix: string } {
  // 形如 msq_sk_live_<22 chars>。dev/test 环境想用 'dev_seed_' 走 SEED_API_KEY env。
  const body = generate22();
  const plaintext = `msq_sk_live_${body}`;
  // 用于 UI 显示和日志检索的不可逆前缀：msq_sk_live_xxxxxxxx****
  const display = `${plaintext.slice(0, 20)}`;
  return { plaintext, prefix: display };
}

export function shortToken(): string {
  return generate8();
}
