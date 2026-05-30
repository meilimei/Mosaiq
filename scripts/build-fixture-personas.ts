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
//   - The persona template factories in @runova/persona-schema use
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
//   - If you upgrade @runova/persona-schema template factories, re-run
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

import {
  type NoiseSeed,
  type Persona,
  parsePersona,
} from '../packages/persona-schema/src/index.js';
import {
  createMacosSonomaChromeUsPersona,
  createUbuntu2204ChromeUsPersona,
  createWin10ChromeUsPersona,
  createWin11ChromeUsPersona,
} from '../packages/persona-schema/src/templates/index.js';
import type { randomNoiseSeed } from '../packages/persona-schema/src/utils/seed.js';

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

/** Shared per-template input (every template factory takes the same shape). */
interface TemplateInput {
  id: string;
  displayName: string;
  tags?: string[];
  notes?: string;
  masterSeed?: ReturnType<typeof randomNoiseSeed>;
}

/**
 * Build a deterministic CI fixture from a template factory: stamp the
 * `template:<id>` tag (CLI `extractTemplateTag` reads it), pin the master
 * seed, and overwrite createdAt/updatedAt with EPOCH so the JSON is
 * byte-stable across regenerations.
 */
function makeFixture(
  id: string,
  displayName: string,
  create: (input: TemplateInput) => Persona,
): Fixture {
  return {
    id,
    build: () => {
      const persona = create({
        id,
        displayName,
        tags: [`template:${id}`, 'fixture', 'ci'],
        notes:
          'Deterministic fixture for the v0.10 Detection Lab CI gate. ' +
          'Do not hand-edit — regenerate via `pnpm build-fixture-personas`.',
        masterSeed: MASTER_SEED as ReturnType<typeof randomNoiseSeed>,
      });
      return {
        ...persona,
        metadata: {
          ...persona.metadata,
          createdAt: EPOCH,
          updatedAt: EPOCH,
        },
      };
    },
  };
}

// One fixture per template in TEMPLATE_CATALOG — the persona matrix the
// Detection Lab CI gate (.github/workflows/detection-lab.yml) runs against.
// Each id needs a matching tests/fixtures/baseline-runs/<id>/baseline.json
// (or the gate runs in bootstrap mode for that persona).
const FIXTURES: Fixture[] = [
  makeFixture('win11-chrome-us', 'CI Fixture — Win11 Chrome US', createWin11ChromeUsPersona),
  makeFixture('win10-chrome-us', 'CI Fixture — Win10 Chrome US', createWin10ChromeUsPersona),
  makeFixture(
    'macos-sonoma-chrome-us',
    'CI Fixture — macOS Sonoma Chrome US',
    createMacosSonomaChromeUsPersona,
  ),
  makeFixture(
    'ubuntu-2204-chrome-us',
    'CI Fixture — Ubuntu 22.04 Chrome US',
    createUbuntu2204ChromeUsPersona,
  ),
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
