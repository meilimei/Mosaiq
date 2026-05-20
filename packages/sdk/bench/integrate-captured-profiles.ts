/// <reference types="node" />
/**
 * integrate-captured-profiles.ts — Phase 7.0
 *
 * Reads every `*.json` capture under `bench/captured-profiles/`, validates
 * each via `convert-captured-profile.ts` helpers, and regenerates
 * `packages/sdk/src/injection/webgl-profiles-captured.ts` containing one
 * `WebglProfile` constant per capture plus a `KNOWN_PROFILES_CAPTURED`
 * registry that `webgl-profiles.ts` re-exports into `KNOWN_PROFILES`.
 *
 * Two modes:
 *   - default (`pnpm bench:integrate-profiles`): regenerate the TS file
 *     in-place from the current JSON set, then exit 0. Use when
 *     adding / updating captures.
 *   - `--check` (`pnpm bench:integrate-profiles -- --check`): regenerate
 *     into a temporary buffer and diff against the on-disk file. Exit 1
 *     if they differ. Used in CI to detect uncommitted regeneration.
 *
 * Single source of truth for the round-trip pipeline:
 *   capture-real-webgl-profile.html  →  *.json  →  integrate  →  TS  →  KNOWN_PROFILES
 *
 * Round-trip invariant: re-running `integrate-captured-profiles --check`
 * on any committed state must produce identical output (no nondeterministic
 * ordering, no time-dependent fields, no env-dependent paths).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emitProfileTypeScript,
  parseCapturePayload,
  suggestMatchRenderer,
  suggestProfileId,
  verifyCapture,
} from './convert-captured-profile.js';
import type { CapturePayload, VerifyResult } from './convert-captured-profile.js';

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const HERE = (() => {
  // Works under tsx / vitest / direct node — both `import.meta.url` and
  // process.cwd fallback for the rare case the URL helper is unavailable.
  try {
    return fileURLToPath(new URL('.', import.meta.url));
  } catch {
    return resolve(process.cwd(), 'packages/sdk/bench');
  }
})();

export const CAPTURED_PROFILES_DIR = resolve(HERE, 'captured-profiles');
export const GENERATED_TS_PATH = resolve(HERE, '../src/injection/webgl-profiles-captured.ts');

// Resolve the bundled biome bin via Node module resolution so the formatter
// works regardless of PATH / pnpm / npx context (CI, direct tsx, vitest).
// The bin is itself a Node script (`#!/usr/bin/env node`), so we invoke
// `process.execPath <biome-bin>` instead of spawning the shim directly —
// fully cross-platform (no `.CMD` shim handling on Windows).
const BIOME_BIN = (() => {
  const req = createRequire(import.meta.url);
  const pkgJson = req.resolve('@biomejs/biome/package.json');
  return resolve(dirname(pkgJson), 'bin/biome');
})();

/**
 * Canonicalize TypeScript source through `biome format --stdin-file-path`
 * so the generator's output matches the project's committed style (single
 * quotes, 100-char line wrap, single-element array inlining per
 * `biome.json`). Without this normalization, the round-trip `--check`
 * would always report drift against any biome-formatted committed state
 * — see `c147296 style: workspace-wide biome format pass` for the source
 * of the original divergence between raw generator output and on-disk
 * format. Throws on biome failure (no silent fallback — a malformed
 * output would surface as drift downstream, masking the real cause).
 */
export function formatWithBiome(source: string, filePath: string): string {
  const result = spawnSync(
    process.execPath,
    [BIOME_BIN, 'format', `--stdin-file-path=${filePath}`],
    { input: source, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error) {
    throw new Error(`[integrate-profiles] biome spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `[integrate-profiles] biome format exited ${result.status}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline core (testable, no I/O)
// ─────────────────────────────────────────────────────────────────────────────

export interface IntegratedProfile {
  /** Source JSON filename (e.g. "intel-uhd-630-d3d11-alice.json") */
  readonly source: string;
  readonly payload: CapturePayload;
  readonly verify: VerifyResult;
  /** Suggested or filename-derived profile id (kebab-case) */
  readonly id: string;
  /** Const name used in the generated TS file (UPPER_SNAKE_CASE) */
  readonly constName: string;
  /** matchRenderer regex literal used in the emitted snippet */
  readonly matchRenderer: RegExp;
}

/**
 * Derive the profile id and matchRenderer from a captured JSON.
 *
 * Rule: the JSON filename **stem** (without `.json`) takes precedence as
 * the profile id when it looks like a stable kebab-case identifier (matches
 * `/^[a-z0-9][a-z0-9-]*$/`). Otherwise we fall back to the auto-suggested
 * id from the renderer string. This lets contributors pin a stable id via
 * filename, and falls back to heuristics for ad-hoc captures.
 */
export function deriveIdentity(
  source: string,
  payload: CapturePayload,
  verify: VerifyResult,
): { id: string; matchRenderer: RegExp; constName: string } {
  const stem = source.replace(/\.json$/i, '').toLowerCase();
  const isStableId = /^[a-z0-9][a-z0-9-]*$/.test(stem);
  const id = isStableId ? stem : suggestProfileId(verify.gpuBrand, payload.renderer);
  const matchRenderer = suggestMatchRenderer(payload.renderer);
  const constName = id
    .toUpperCase()
    .replace(/-/g, '_')
    .replace(/[^A-Z0-9_]/g, '_');
  return { id, matchRenderer, constName };
}

/**
 * Process one capture JSON string into an IntegratedProfile. Pure function;
 * no filesystem I/O. Used by both the CLI and the tests.
 */
export function integrateOne(source: string, raw: string): IntegratedProfile {
  const payload = parseCapturePayload(raw);
  const verify = verifyCapture(payload);
  const { id, matchRenderer, constName } = deriveIdentity(source, payload, verify);
  return { source, payload, verify, id, constName, matchRenderer };
}

/**
 * Render the complete `webgl-profiles-captured.ts` source from a list of
 * IntegratedProfile entries. Output is deterministic: profiles are sorted
 * by id ascending; const order in `KNOWN_PROFILES_CAPTURED` follows the
 * same sort.
 */
export function renderGeneratedSource(profiles: readonly IntegratedProfile[]): string {
  const sorted = [...profiles].sort((a, b) => a.id.localeCompare(b.id));

  const headerComment =
    `/**\n` +
    ` * webgl-profiles-captured.ts — AUTO-GENERATED by\n` +
    ` *   pnpm --filter @mosaiq/sdk run bench:integrate-profiles\n` +
    ` *\n` +
    ` * DO NOT EDIT BY HAND. Drop a new \`*.json\` capture into\n` +
    ` * \`packages/sdk/bench/captured-profiles/\` and re-run integrate;\n` +
    ` * commit the regenerated TS together with the JSON.\n` +
    ` *\n` +
    ` * CI runs \`bench:integrate-profiles -- --check\` to detect drift\n` +
    ` * between the on-disk JSONs and this file.\n` +
    ` */\n\n`;

  if (sorted.length === 0) {
    // Empty: only `WebglProfile` type is referenced (for the array annotation).
    return (
      headerComment +
      `import type { WebglProfile } from './webgl-profiles.js';\n\n` +
      `// (no captured profiles yet — see bench/captured-profiles/README.md)\n\n` +
      `export const KNOWN_PROFILES_CAPTURED: readonly WebglProfile[] = [];\n`
    );
  }

  // Type-only import (erased at compile time) — avoids the ESM circular
  // dependency that would otherwise arise because webgl-profiles.ts itself
  // imports `KNOWN_PROFILES_CAPTURED` from this file. With a runtime
  // `import { GL }` the captured module would evaluate while
  // webgl-profiles.ts is still initializing, leaving `GL` as undefined.
  // We therefore emit GL constants inline as `0xHEX /* NAME */` literals
  // (see emitProfileTypeScript({ inlineGlKeys: true })).
  const header =
    headerComment + `import type { GlParamValue, WebglProfile } from './webgl-profiles.js';\n\n`;

  const blocks: string[] = [];
  for (const p of sorted) {
    blocks.push(
      emitProfileTypeScript(p.payload, p.verify, {
        id: p.id,
        matchRenderer: p.matchRenderer,
        inlineGlKeys: true,
      }),
    );
  }

  const registry =
    `export const KNOWN_PROFILES_CAPTURED: readonly WebglProfile[] = [\n` +
    sorted.map((p) => `  ${p.constName},`).join('\n') +
    `\n];\n`;

  return `${header}${blocks.join('\n')}\n${registry}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem driver (CLI entry point)
// ─────────────────────────────────────────────────────────────────────────────

export interface IntegrateRunResult {
  readonly profiles: readonly IntegratedProfile[];
  readonly generatedSource: string;
  /** True if the generated source matches the on-disk file (or no on-disk file). */
  readonly inSync: boolean;
}

/**
 * Read every capture JSON, integrate it, and produce the rendered TS
 * source. Pure with respect to the filesystem reads (writes are caller's
 * choice via `runIntegrate`).
 */
export function loadCapturedProfiles(dir: string): IntegratedProfile[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const jsons = files.filter((f) => f.endsWith('.json')).sort();
  return jsons.map((f) => integrateOne(f, readFileSync(join(dir, f), 'utf-8')));
}

export interface RunOptions {
  readonly dir?: string;
  readonly outPath?: string;
  readonly check?: boolean;
}

export function runIntegrate(opts: RunOptions = {}): IntegrateRunResult {
  const dir = opts.dir ?? CAPTURED_PROFILES_DIR;
  const outPath = opts.outPath ?? GENERATED_TS_PATH;
  const profiles = loadCapturedProfiles(dir);
  // Pipe through biome so the on-disk file matches the project's canonical
  // style (single quotes, 100-char wrap). Keeps `renderGeneratedSource`
  // pure for unit tests while making the I/O layer round-trip-stable
  // against any committed file that's already been `biome format`-ed.
  const generatedSource = formatWithBiome(renderGeneratedSource(profiles), outPath);

  let onDisk = '';
  try {
    onDisk = readFileSync(outPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const inSync = onDisk === generatedSource;

  if (!opts.check) {
    if (!inSync) writeFileSync(outPath, generatedSource);
  }

  return { profiles, generatedSource, inSync };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function isMain(): boolean {
  // Detect direct execution via tsx (`tsx bench/integrate-captured-profiles.ts`).
  // import.meta.url ends with the file path; argv[1] resolves to the same path
  // (or its compiled equivalent under node). Vitest sets argv[1] to the
  // worker script, so this guards against double-execution during tests.
  try {
    const here = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return resolve(argv1) === here;
  } catch {
    return false;
  }
}

function main(): void {
  const check = process.argv.includes('--check');
  const result = runIntegrate({ check });
  const n = result.profiles.length;

  if (check) {
    if (result.inSync) {
      console.log(`[integrate-profiles] ✅ in sync (${n} profile${n === 1 ? '' : 's'})`);
      process.exit(0);
    } else {
      console.error(
        `[integrate-profiles] ❌ DRIFT detected — webgl-profiles-captured.ts is\n` +
          `out of date with bench/captured-profiles/*.json. Re-run:\n\n` +
          `  pnpm --filter @mosaiq/sdk run bench:integrate-profiles\n\n` +
          `and commit both the JSON and the regenerated TS file.`,
      );
      process.exit(1);
    }
  }

  console.log(`[integrate-profiles] processed ${n} capture${n === 1 ? '' : 's'}`);
  for (const p of result.profiles) {
    const verdict = p.verify.verdict === 'PASS' ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${verdict}  ${p.id.padEnd(40)}  (from ${p.source})`);
  }
  if (result.inSync) {
    console.log(`[integrate-profiles] webgl-profiles-captured.ts already in sync`);
  } else {
    console.log(`[integrate-profiles] wrote ${GENERATED_TS_PATH}`);
  }
}

if (isMain()) {
  try {
    main();
  } catch (err) {
    console.error(`[integrate-profiles] FAILED: ${(err as Error).message}`);
    process.exit(2);
  }
}
