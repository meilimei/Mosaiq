#!/usr/bin/env node
// =============================================================================
// scripts/build-leaderboard.mts
//
// Generate the public Detection Lab leaderboard as a self-contained static
// HTML page from the committed baseline runs under
// `tests/fixtures/baseline-runs/<persona-id>/baseline.json`.
//
// Each persona in the persona-schema TEMPLATE_CATALOG that has a committed
// baseline becomes a row (engine = "Mosaiq"). Personas without a baseline
// yet are skipped with a bootstrap hint — the page still renders (empty
// state if none exist). We deliberately do NOT fabricate competitor rows;
// they are only added when a real measured run exists.
//
// Run via tsx so we can import the SDK + persona-schema sources directly
// (the leaderboard module is pure — no playwright/runtime deps pulled in).
//
// Usage:
//   pnpm build-leaderboard                 # → _site/leaderboard/index.html
//   pnpm build-leaderboard --out <dir>     # write index.html into <dir>
//   pnpm build-leaderboard --now <iso>     # pin generatedAt (deterministic)
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEMPLATE_CATALOG } from '../packages/persona-schema/src/templates/index.js';
// Import the leaderboard module + its types directly (not via the
// detection-lab barrel). The barrel re-exports the runner, which pulls in
// `injection/build-config.ts` → `@mosaiq/persona-schema/dist` — a built
// artifact this workflow deliberately doesn't produce. The leaderboard
// module itself is dependency-free, so the direct import keeps `tsx`
// resolving against sources only.
import {
  type LeaderboardEntry,
  buildLeaderboard,
  renderLeaderboardHtml,
} from '../packages/sdk/src/detection-lab/leaderboard.js';
import type { DetectionRun } from '../packages/sdk/src/detection-lab/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BASELINE_DIR = resolve(ROOT, 'tests', 'fixtures', 'baseline-runs');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const outArg = argValue('--out');
const outDir = outArg ? resolve(process.cwd(), outArg) : resolve(ROOT, '_site', 'leaderboard');
const nowIso = argValue('--now');

const entries: LeaderboardEntry[] = [];
const missing: string[] = [];

for (const template of TEMPLATE_CATALOG) {
  const baselinePath = resolve(BASELINE_DIR, template.id, 'baseline.json');
  if (!existsSync(baselinePath)) {
    missing.push(template.id);
    continue;
  }
  const run = JSON.parse(readFileSync(baselinePath, 'utf-8')) as DetectionRun;
  entries.push({
    engine: 'Mosaiq',
    personaLabel: template.displayName,
    run,
  });
}

const model = buildLeaderboard(entries, nowIso ? { nowIso } : {});
const html = renderLeaderboardHtml(model);

mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'index.html');
writeFileSync(outPath, html);

console.log(`✓ wrote ${outPath} (${entries.length} persona row(s), ${html.length} bytes)`);
if (missing.length > 0) {
  console.log(
    `ℹ ${missing.length} persona(s) have no committed baseline yet — skipped: ${missing.join(', ')}`,
  );
  console.log(
    '  Bootstrap a baseline via the Detection Lab workflow, then ' +
      '`node scripts/ci-compare-baseline.mjs write-baseline ...` (see ' +
      'tests/fixtures/baseline-runs/README.md).',
  );
}
