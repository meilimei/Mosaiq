#!/usr/bin/env node
// =============================================================================
// scripts/build-fixture-personas.ts
//
// Deterministically (re)build the persona fixtures used by the v0.10
// Detection Lab CI gate (`tests/fixtures/personas/<id>.json`).
//
// Why this exists:
//   - The CI workflow (.github/workflows/detection-lab.yml, phase 10.7)
//     seeds these JSON files into ~/.mosaiq/personas/ before running
//     `mosaiq detection-lab run-all`. They MUST be byte-stable across
//     regenerations — otherwise the workflow's baseline JSON would drift
//     for reasons unrelated to anti-detection behavior, swamping the
//     regression signal.
//   - The persona template factories in @mosaiq/persona-schema use
//     `randomNoiseSeed()` + `new Date().toISOString()` by default. This
//     script overrides both with deterministic inputs (fixed master seed
//     + epoch timestamps) so the output is reproducible.
//
// Run via tsx (not plain node) so we can import from the workspace package
// sources directly without a prior `pnpm build` step. tsx is already a
// root devDependency (used by `pnpm mosaiq`).
//
// Authoring policy (do NOT hand-edit the generated JSON files):
//   - If you need to change the fixture, edit this script + re-run it.
//   - If you upgrade @mosaiq/persona-schema template factories, re-run
//     this script and commit the regenerated JSON in the same PR.
//   - CI runs `--check` to fail loudly if the committed JSON drifts from
//     what the current script would generate.
//
// Usage:
//   pnpm build-fixture-personas            # rewrite tests/fixtures/personas/*.json
//   pnpm build-fixture-personas --check    # drift check: exit 1 if outdated
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type NoiseSeed, type Persona, parsePersona } from '../packages/persona-schema/src/index.js';
import { createWin11ChromeUsPersona } from '../packages/persona-schema/src/templates/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FIXTURE_DIR = resolve(ROOT, 'tests', 'fixtures', 'personas');

// 1970-01-01 epoch — same constant the SDK's stripRunForBaseline uses for
// stripped timestamps. Choosing it here keeps the fixture's metadata
// timestamps visually obviously "this is a fixture, not a real run".
const EPOCH = '1970-01-01T00:00:00.000Z';

// 8-hex-char NoiseSeed (`/^[0-9a-f]{8}$/`). Mnemonic, well-known.
const MASTER_SEED: NoiseSeed = 'deadbeef' as NoiseSeed;

// ─────────────────────────────────────────────────────────────────────────────
// Fixture registry
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture {
  /** kebab-case persona id, also the JSON filename stem */
  id: string;
  build: () => Persona;
}

const FIXTURES: Fixture[] = [
  {
    id: 'win11-chrome-us',
    build: () => {
      const persona = createWin11ChromeUsPersona({
        id: 'win11-chrome-us',
        displayName: 'CI Fixture — Win11 Chrome US',
        // 'template:<id>' tag is what CLI `extractTemplateTag` reads to stamp
        // raw.persona.template. Keep it first so it's visible in `personas list`.
        tags: ['template:win11-chrome-us', 'fixture', 'ci'],
        notes:
          'Deterministic fixture for the v0.10 Detection Lab CI gate. ' +
          'Do not hand-edit — regenerate via `pnpm build-fixture-personas`.',
        masterSeed: MASTER_SEED as ReturnType<
          typeof import('../packages/persona-schema/src/utils/seed.js').randomNoiseSeed
        >,
      });
      // Override createdAt / updatedAt — template factory uses `new Date()`
      // and we need stable bytes across regenerations.
      return {
        ...persona,
        metadata: {
          ...persona.metadata,
          createdAt: EPOCH,
          updatedAt: EPOCH,
        },
      };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Generation + (optional) drift check
// ─────────────────────────────────────────────────────────────────────────────

const checkMode = process.argv.includes('--check');

let driftCount = 0;

for (const fixture of FIXTURES) {
  const persona = fixture.build();

  // Schema validation — confirm we didn't accidentally produce something
  // the workspace consumers (CLI / SDK runner) would reject at import time.
  parsePersona(persona);

  // Pretty-printed JSON + trailing newline (POSIX text file convention,
  // also keeps diff tooling happy at file boundaries).
  const json = `${JSON.stringify(persona, null, 2)}\n`;
  const outPath = resolve(FIXTURE_DIR, `${fixture.id}.json`);

  if (checkMode) {
    if (!existsSync(outPath)) {
      console.error(`❌ Missing fixture: ${outPath}`);
      driftCount += 1;
      continue;
    }
    const existing = readFileSync(outPath, 'utf-8').replace(/\r\n/g, '\n');
    if (existing !== json) {
      console.error(`❌ Fixture drift: ${outPath}`);
      console.error('   Re-run `pnpm build-fixture-personas` and commit the result.');
      driftCount += 1;
    }
    continue;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  console.log(`✓ wrote ${outPath} (${json.length} bytes)`);
}

if (checkMode) {
  if (driftCount > 0) {
    console.error(`\n❌ ${driftCount} fixture(s) drifted from the generator.\n`);
    process.exit(1);
  }
  console.log(`✓ all ${FIXTURES.length} fixture(s) match the generator output.`);
}
