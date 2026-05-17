/**
 * 校验 SDK_VERSION 常量与 package.json 同步——避免发版漂移。
 *
 * 失败时通常意味着改了 package.json 的 version 字段但忘了同步 src/version.ts
 * （反之亦然）。修复：编辑 `src/version.ts` 让 SDK_VERSION 与 package.json 一致。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SDK_VERSION } from './version.js';

describe('SDK_VERSION', () => {
  it('matches package.json version exactly', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
