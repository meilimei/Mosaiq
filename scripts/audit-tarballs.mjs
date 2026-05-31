#!/usr/bin/env node
// =============================================================================
// scripts/audit-tarballs.mjs
//
// Verify that the npm tarballs for our four publishable packages
// (@runova/persona-schema, @runova/sdk, @runova/cli, @runova/cloud-sdk)
// contain exactly the expected files: all REQUIRED entries present, no
// FORBIDDEN entries leaked.
//
// Why this exists:
//   - Each package's `files` field in package.json is a whitelist, but
//     mistakes happen (a typo, a missing entry after refactor, a stray
//     bench/ directory accidentally globbed in). This script is a CI gate
//     that catches them before `npm publish`.
//   - Especially critical for @runova/sdk: the workspace contains a 27 GB
//     `chromium-fork/` tree and a `bench/` directory with multi-MB captured
//     fingerprint profiles. Both MUST stay out of the npm tarball.
//
// Strategy:
//   - For each package, run `npm pack --dry-run --json` and parse the
//     file list (no actual tarball is written).
//   - Assert REQUIRED files are present.
//   - Assert no FORBIDDEN substring appears in any file path.
//   - Exit 1 with a per-violation list on failure; 0 with a summary on pass.
//
// Run via:
//   pnpm run audit-tarballs
// =============================================================================

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PACKAGES = [
  {
    name: '@runova/persona-schema',
    dir: 'packages/persona-schema',
    required: [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/templates/index.js',
      'dist/templates/index.d.ts',
    ],
    forbidden: [
      'bench/',
      'src/',
      'examples/',
      'tsconfig.json',
      'vitest.config',
      '.test.',
      'chromium-fork',
      'node_modules',
    ],
  },
  {
    name: '@runova/sdk',
    dir: 'packages/sdk',
    required: [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
      'dist/launcher.js',
      'dist/launcher.d.ts',
      'patches/playwright-core@1.59.1.patch',
      'scripts/postinstall.cjs',
    ],
    forbidden: [
      'bench/',
      'src/',
      'examples/',
      'tsconfig.json',
      'vitest.config',
      '.test.',
      'chromium-fork',
      'node_modules',
      'captured-profiles',
    ],
  },
  {
    name: '@runova/cli',
    dir: 'packages/cli',
    required: ['package.json', 'README.md', 'LICENSE', 'bin/mosaiq.js', 'dist/cli.js'],
    forbidden: [
      'src/',
      'tsconfig.json',
      'vitest.config',
      '.test.',
      'chromium-fork',
      'node_modules',
    ],
  },
  {
    name: '@runova/cloud-sdk',
    dir: 'packages/cloud-sdk',
    required: [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
    ],
    forbidden: [
      'src/',
      // e2e-smoke / register-persona 等运维脚本不应进 tarball（files 只列 dist/README/LICENSE）。
      'scripts/',
      'tsconfig.json',
      'vitest.config',
      '.test.',
      'chromium-fork',
      'node_modules',
    ],
  },
];

const violations = [];

function checkPackage(pkg) {
  const pkgDir = resolve(ROOT, pkg.dir);
  console.log(`\n--- Auditing ${pkg.name} (${pkg.dir}) ---`);

  // Use shell: true so Windows resolves `npm.cmd` correctly.
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgDir,
    encoding: 'utf-8',
    shell: true,
  });

  if (result.status !== 0) {
    violations.push(`${pkg.name}: npm pack --dry-run failed:\n${result.stderr}`);
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    violations.push(`${pkg.name}: failed to parse npm pack JSON output: ${e?.message}`);
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    violations.push(`${pkg.name}: empty npm pack output`);
    return;
  }

  const entry = parsed[0];
  const fileList = entry.files.map((f) => f.path);

  // Check required entries — match exact or prefix (so adding files under
  // dist/<subdir>/ doesn't break the audit).
  const missing = [];
  for (const req of pkg.required) {
    const hit = fileList.some((p) => p === req || p.startsWith(`${req}/`));
    if (!hit) missing.push(req);
  }
  if (missing.length > 0) {
    for (const m of missing) {
      violations.push(`${pkg.name}: MISSING required file: ${m}`);
    }
  }

  // Check forbidden — any file path containing the forbidden substring trips.
  const leaked = [];
  for (const f of fileList) {
    for (const forb of pkg.forbidden) {
      if (f.includes(forb)) leaked.push({ file: f, pattern: forb });
    }
  }
  if (leaked.length > 0) {
    for (const l of leaked) {
      violations.push(`${pkg.name}: FORBIDDEN file leaked: "${l.file}" matches "${l.pattern}"`);
    }
  }

  const sizeKB = (entry.size / 1024).toFixed(1);
  const unpackedKB = (entry.unpackedSize / 1024).toFixed(1);
  console.log(
    `  ${fileList.length} files, ${sizeKB} kB packed, ${unpackedKB} kB unpacked${missing.length === 0 && leaked.length === 0 ? '  ✓' : '  ✗'}`,
  );
}

for (const pkg of PACKAGES) {
  checkPackage(pkg);
}

console.log('\n========================================');
if (violations.length === 0) {
  console.log('✓ All publishable tarballs pass audit.');
  process.exit(0);
} else {
  console.error(`❌ Tarball audit FAILED with ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  console.error('\nFix the package.json `files` field (or build output) and re-run.');
  process.exit(1);
}
