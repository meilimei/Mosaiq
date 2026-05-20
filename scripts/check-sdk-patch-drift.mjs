#!/usr/bin/env node
// =============================================================================
// scripts/check-sdk-patch-drift.mjs
//
// Verify that the rebrowser-patches playwright-core@1.59.1 patch is identical
// between the monorepo workspace root (`patches/`) and the sdk package
// (`packages/sdk/patches/`).
//
// Why this exists:
//   - Workspace install (pnpm) uses `patches/playwright-core@1.59.1.patch`
//     via `pnpm.patchedDependencies` in the root package.json.
//   - Consumer install (npm i @mosaiq/sdk) uses
//     `packages/sdk/patches/playwright-core@1.59.1.patch` via the SDK's
//     postinstall script (see packages/sdk/scripts/postinstall.cjs).
//   - These two MUST stay byte-identical so workspace + consumer behavior is
//     the same. Easy to forget after editing the patch.
//
// Fix on failure: copy whichever side is authoritative to the other.
//   cp patches/playwright-core@1.59.1.patch packages/sdk/patches/playwright-core@1.59.1.patch
//
// Run via:
//   pnpm run check-sdk-patch-drift
//   (or wired into CI; see .github/workflows/ci.yml)
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ROOT_PATCH = resolve(ROOT, 'patches', 'playwright-core@1.59.1.patch');
const SDK_PATCH = resolve(ROOT, 'packages', 'sdk', 'patches', 'playwright-core@1.59.1.patch');

function fail(msg) {
  // eslint-disable-next-line no-console
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!existsSync(ROOT_PATCH)) fail(`Missing: ${ROOT_PATCH}`);
if (!existsSync(SDK_PATCH)) fail(`Missing: ${SDK_PATCH}`);

// Normalize line endings before comparing so Windows checkouts without
// .gitattributes don't trip a false-positive drift.
const norm = (buf) => buf.toString('utf-8').replace(/\r\n/g, '\n');
const rootContent = norm(readFileSync(ROOT_PATCH));
const sdkContent = norm(readFileSync(SDK_PATCH));

if (rootContent !== sdkContent) {
  // eslint-disable-next-line no-console
  console.error(`
❌ Patch drift: root patches/ and packages/sdk/patches/ differ.

  root: ${ROOT_PATCH}
  sdk:  ${SDK_PATCH}

To fix, copy the authoritative version to the other location:

  cp "${ROOT_PATCH}" "${SDK_PATCH}"

or vice versa, depending on which one is the source of truth.
`);
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log('✓ playwright-core@1.59.1 patch is in sync between workspace root and @mosaiq/sdk.');
