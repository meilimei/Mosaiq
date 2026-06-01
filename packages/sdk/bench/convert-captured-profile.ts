/// <reference types="node" />
/**
 * convert-captured-profile.ts — Phase 5.3b
 *
 * Pipeline for the Mosaiq real-hardware WebGL profile collection workflow.
 *
 *   1. User opens `bench/capture-real-webgl-profile.html` on real hardware.
 *   2. Copies the JSON payload from the textarea.
 *   3. Runs this tool with the JSON piped in (or via `--file`).
 *   4. Tool reports:
 *      - Capture sanity check (counts, brand)
 *      - CreepJS whitelist hit / miss verdict (cap + brand hash)
 *      - Suggested TypeScript snippet ready to paste into
 *        `packages/sdk/src/injection/webgl-profiles.ts`
 *
 * Verdict alone is enough for users to know whether their profile would
 * eliminate the CreepJS WebGL bold-fail. Even non-hit profiles are useful
 * (other detectors don't use the CreepJS whitelist) — we always emit a
 * paste-ready snippet.
 *
 * Run:
 *   echo "<paste json>" | pnpm --filter @runova/sdk exec tsx bench/convert-captured-profile.ts
 *   pnpm --filter @runova/sdk exec tsx bench/convert-captured-profile.ts --file capture.json
 *   pnpm --filter @runova/sdk exec tsx bench/convert-captured-profile.ts --self-test
 */

import { readFileSync } from 'node:fs';

import {
  FLOAT32_ARRAY_PARAMS,
  GL,
  INT32_ARRAY_PARAMS,
  STRING_PARAMS,
} from '../src/injection/webgl-profiles.js';
import type { GlParamValue, WebglProfile } from '../src/injection/webgl-profiles.js';

import {
  BRAND_SET,
  CAPABILITIES_SET,
  brandHash,
  capabilitiesHash,
  extractCreepjsWebglParams,
} from './creepjs-whitelist-data.js';

// ─────────────────────────────────────────────────────────────────────────────
// Capture JSON shape (must match capture-real-webgl-profile.html output)
// ─────────────────────────────────────────────────────────────────────────────

export interface CapturePayload {
  readonly schemaVersion: string;
  readonly captureDate: string;
  readonly userAgent: string;
  readonly vendor: string;
  readonly renderer: string;
  /** key: "0x..." hex string, value: number | number[] | string */
  readonly webgl1: Readonly<Record<string, number | readonly number[] | string>>;
  /** key: "0x..." hex string, value: number | number[] | string */
  readonly webgl2: Readonly<Record<string, number | readonly number[] | string>>;
  readonly preview?: {
    readonly sortedUniqueParamCount: number;
    readonly capabilitiesHashInt32: number;
    readonly brandCapabilitiesHex: string;
    readonly gpuBrand: string;
    readonly webgl2Available: boolean;
  };
}

export function parseCapturePayload(raw: string): CapturePayload {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Capture is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof json !== 'object' || json === null) {
    throw new Error('Capture root must be an object');
  }
  const o = json as Record<string, unknown>;
  if (o.schemaVersion !== 'mosaiq-webgl-capture/1') {
    throw new Error(`Unsupported schemaVersion: ${String(o.schemaVersion)}`);
  }
  if (typeof o.renderer !== 'string' || typeof o.vendor !== 'string') {
    throw new Error('Capture must include renderer + vendor strings');
  }
  if (typeof o.webgl1 !== 'object' || o.webgl1 === null) {
    throw new Error('Capture must include webgl1 param map');
  }
  if (typeof o.webgl2 !== 'object' || o.webgl2 === null) {
    throw new Error('Capture must include webgl2 param map (use {} if WebGL2 unavailable)');
  }
  return o as unknown as CapturePayload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hex string → number; build Map for hashing
// ─────────────────────────────────────────────────────────────────────────────

function hexKeyToNumber(key: string): number {
  if (!/^0x[0-9a-fA-F]+$/.test(key)) {
    throw new Error(`Invalid hex key in capture: ${key}`);
  }
  return Number.parseInt(key, 16);
}

export function buildParamMap(
  obj: Readonly<Record<string, number | readonly number[] | string>>,
): Map<number, GlParamValue> {
  const out = new Map<number, GlParamValue>();
  for (const [k, v] of Object.entries(obj)) {
    out.set(hexKeyToNumber(k), v);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CreepJS brand detection (lifted from verify-creepjs-profile-hash.ts)
// ─────────────────────────────────────────────────────────────────────────────

export function getGpuBrand(unmaskedRenderer: string): string {
  const r = unmaskedRenderer;
  if (/Intel/i.test(r)) return 'Intel';
  if (/NVIDIA/i.test(r)) return 'NVIDIA';
  if (/AMD|Radeon/i.test(r)) return 'AMD';
  if (/Apple/i.test(r)) return 'Apple';
  if (/Google/i.test(r)) return 'Google';
  if (/Adreno|Qualcomm/i.test(r)) return 'Qualcomm';
  if (/Mali/i.test(r)) return 'Mali';
  if (/PowerVR/i.test(r)) return 'PowerVR';
  return '';
}

/**
 * Phase 5.4 — detect software-rasterizer fallbacks vs real GPU hardware.
 *
 * Real users sometimes capture with hardware acceleration disabled (browser
 * setting toggled off, GPU drivers missing, VM without GPU passthrough, …).
 * The capture itself is technically valid, but submitting such a profile to
 * `KNOWN_PROFILES` is anti-detection-counterproductive:
 *
 *   - CreepJS whitelists are populated from real consumer GPUs only —
 *     software-fallback hashes won't appear there.
 *   - Plausibility check fails: a Mosaiq persona claiming
 *     "Windows 11 + Chrome 147 + Microsoft Basic Render Driver" is itself
 *     a distinctive fingerprint that detectors like amiunique /
 *     fingerprint-scan flag as unusual (most consumer Windows users have
 *     working drivers).
 *
 * Patterns covered:
 *   - **Microsoft Basic Render Driver** (Windows D3D11 WARP CPU rasterizer
 *     — surfaced by Edge / Chrome on Windows when GPU acceleration is off
 *     or drivers missing).
 *   - **SwiftShader** (Google's portable CPU GL implementation; embedded
 *     in Chromium; activated when GPU is unavailable).
 *   - **llvmpipe** (Mesa Gallium software driver on Linux/BSD).
 *   - **Generic "Software" / "Software Rasterizer"** strings (covers
 *     headless / WSL / niche driver fallbacks).
 *
 * Returned along with `isSoftware`: a short user-facing diagnostic note
 * suggesting the most-likely fix.
 */
export interface SoftwareRendererDetection {
  readonly isSoftware: boolean;
  /** Short human-readable label of which fallback was matched. */
  readonly label: string;
  /** Suggested user action to recapture against real GPU. */
  readonly hint: string;
}

export function detectSoftwareRenderer(unmaskedRenderer: string): SoftwareRendererDetection {
  const r = unmaskedRenderer;
  if (/Microsoft Basic Render Driver/i.test(r)) {
    return {
      isSoftware: true,
      label: 'Microsoft Basic Render Driver (Windows D3D11 WARP — CPU rasterizer)',
      hint: 'Enable hardware acceleration in your browser (Edge: edge://settings/system → "Use graphics acceleration when available"; Chrome: chrome://settings/system), then verify chrome://gpu / edge://gpu shows "Hardware accelerated" before recapturing.',
    };
  }
  if (/SwiftShader/i.test(r)) {
    return {
      isSoftware: true,
      label: 'SwiftShader (Chromium portable CPU GL fallback)',
      hint: 'Your browser is using the bundled CPU rasterizer. Toggle hardware acceleration on, install / update GPU drivers, or run on a host with a real GPU before recapturing.',
    };
  }
  if (/llvmpipe/i.test(r)) {
    return {
      isSoftware: true,
      label: 'Mesa llvmpipe (Linux/BSD software driver)',
      hint: 'Mesa fell back to CPU rendering. Install / load proprietary or open-source GPU drivers (e.g. nvidia, amdgpu, i915), confirm with `glxinfo | grep "OpenGL renderer"`, then recapture.',
    };
  }
  if (/(?:^|[^A-Za-z])Software(?:\s+Rasterizer)?(?:[^A-Za-z]|$)/i.test(r)) {
    return {
      isSoftware: true,
      label: 'Generic software rasterizer',
      hint: 'The renderer string self-identifies as a software fallback. Enable GPU acceleration / install drivers and recapture.',
    };
  }
  return { isSoftware: false, label: '', hint: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify against CreepJS whitelist
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  readonly gpuBrand: string;
  readonly sortedUniqueParams: readonly number[];
  readonly capHash: number;
  readonly capInWhitelist: boolean;
  readonly brandHashValue: string;
  readonly brandInWhitelist: boolean;
  readonly verdict: 'PASS' | 'FAIL';
}

export function verifyCapture(payload: CapturePayload): VerifyResult {
  const brand = getGpuBrand(payload.renderer);
  const w1 = buildParamMap(payload.webgl1);
  const w2 = buildParamMap(payload.webgl2);
  const params = extractCreepjsWebglParams(w1, w2);
  const cap = capabilitiesHash(params);
  const brandH = brandHash(brand, params);
  const capHit = CAPABILITIES_SET.has(cap);
  const brandHit = BRAND_SET.has(brandH);
  return {
    gpuBrand: brand,
    sortedUniqueParams: params,
    capHash: cap,
    capInWhitelist: capHit,
    brandHashValue: brandH,
    brandInWhitelist: brandHit,
    verdict: capHit && brandHit ? 'PASS' : 'FAIL',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggest a profile id + matchRenderer regex
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Profile id heuristic — examples:
 *   - "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 ..."        → nvidia-rtx-4090-d3d11
 *   - "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, ..." → apple-m2-metal
 *   - "ANGLE (Intel, Mesa Intel(R) UHD Graphics ..."      → intel-uhd-graphics-opengl
 *   - "Apple GPU"                                         → apple-gpu-(unknown)
 *
 * Heuristic is best-effort — user expected to refine for clarity.
 */
export function suggestProfileId(brand: string, renderer: string): string {
  const lower = renderer.toLowerCase();

  // Extract model fragment. Order matters — prefer the more specific
  // patterns first (uhd before plain hd, iris-xe before iris).
  let model = '';
  let mGeneric: RegExpMatchArray | null;
  if ((mGeneric = lower.match(/rtx\s*(\d{4})/))) model = `rtx-${mGeneric[1]}`;
  else if ((mGeneric = lower.match(/gtx\s*(\d{3,4})/))) model = `gtx-${mGeneric[1]}`;
  else if ((mGeneric = lower.match(/rx\s*(\d{4})/))) model = `rx-${mGeneric[1]}`;
  else if ((mGeneric = lower.match(/uhd\s*(?:graphics\s*)?(\d{3})/))) model = `uhd-${mGeneric[1]}`;
  // Plain "HD Graphics ###" — Intel iGPU pre-Skylake naming (HD 520, HD 4000…).
  // Word-boundary on left avoids matching the "HD" inside "UHD".
  else if ((mGeneric = lower.match(/(?:^|[^a-z])hd\s*graphics\s*(\d{3,4})/)))
    model = `hd-${mGeneric[1]}`;
  else if ((mGeneric = lower.match(/iris\s*xe/))) model = 'iris-xe';
  else if ((mGeneric = lower.match(/iris\s*pro/))) model = 'iris-pro';
  else if ((mGeneric = lower.match(/iris\s*plus/))) model = 'iris-plus';
  else if ((mGeneric = lower.match(/apple\s*m(\d)/))) model = `m${mGeneric[1]}`;
  else if ((mGeneric = lower.match(/adreno\s*(\d{3,4})/))) model = `adreno-${mGeneric[1]}`;
  else if ((mGeneric = lower.match(/mali-?(\w+)/))) model = `mali-${mGeneric[1]}`;
  else model = 'unknown';

  // Backend
  let backend = 'unknown';
  if (/Direct3D11|D3D11/i.test(renderer)) backend = 'd3d11';
  else if (/Direct3D12|D3D12/i.test(renderer)) backend = 'd3d12';
  else if (/Metal/i.test(renderer)) backend = 'metal';
  else if (/Vulkan/i.test(renderer)) backend = 'vulkan';
  else if (/OpenGL|Mesa/i.test(renderer)) backend = 'opengl';

  const brandLower = brand.toLowerCase() || 'unknown';
  return `${brandLower}-${model}-${backend}`;
}

/**
 * matchRenderer regex heuristic — try to extract a model token that uniquely
 * identifies this GPU class. We prefer `\b<model>\b` for word-boundary safety.
 */
export function suggestMatchRenderer(renderer: string): RegExp {
  const tokens = [
    /RTX\s*\d{4}/i,
    /GTX\s*\d{3,4}/i,
    /RX\s*\d{4}/i,
    /UHD\s*Graphics\s*\d{3}/i,
    /Iris\s*Xe/i,
    /Apple\s*M\d/i,
    /Adreno\s*\d{3,4}/i,
    /Mali-\w+/i,
  ];
  for (const t of tokens) {
    const m = renderer.match(t);
    if (m) return new RegExp(`\\b${m[0]}\\b`, 'i');
  }
  // Fallback: literal renderer (unlikely to be useful but safe)
  return new RegExp(renderer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// ─────────────────────────────────────────────────────────────────────────────
// TypeScript source emission
// ─────────────────────────────────────────────────────────────────────────────

/** Build hex → GL constant name reverse map for readable TS output. */
function buildGlNameMap(): Map<number, string> {
  const m = new Map<number, string>();
  for (const [name, val] of Object.entries(GL)) {
    m.set(val, name);
  }
  return m;
}

const GL_NAMES = buildGlNameMap();

function glKey(numKey: number, inline: boolean): string {
  const name = GL_NAMES.get(numKey);
  // `inline` mode (used by integrate-captured-profiles auto-gen) emits the
  // hex literal with the name as a trailing comment, so the auto-generated
  // file does NOT need a runtime import of `GL` from webgl-profiles.ts —
  // that runtime import causes an ESM circular dependency because
  // webgl-profiles.ts itself imports KNOWN_PROFILES_CAPTURED from the
  // generated file (during init `GL` is still `undefined`).
  // The hand-paste path keeps the readable `GL.NAME` form because the
  // user is splicing into webgl-profiles.ts where `GL` is in scope.
  const hex = `0x${numKey.toString(16).padStart(4, '0')}`;
  if (inline) return name ? `${hex} /* ${name} */` : hex;
  return name ? `GL.${name}` : hex;
}

function valueLiteral(numKey: number, v: number | readonly number[] | string): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  // Number — render large stencil masks as hex for readability
  if (typeof v === 'number') {
    if (v === 0x7fffffff) return '0x7fffffff';
    if (v === 0xfffffffe) return '0xfffffffe';
    return String(v);
  }
  return JSON.stringify(v);
}

function emitMap(
  varName: string,
  obj: Readonly<Record<string, number | readonly number[] | string>>,
  inlineGlKeys: boolean,
): string {
  const lines: string[] = [];
  // Sort entries by hex key for stable diff-friendly output
  const entries = Object.entries(obj)
    .map(([k, v]) => ({ k, n: hexKeyToNumber(k), v }))
    .sort((a, b) => a.n - b.n);
  for (const e of entries) {
    lines.push(`    [${glKey(e.n, inlineGlKeys)}, ${valueLiteral(e.n, e.v)}],`);
  }
  return `  ${varName}: new Map<number, GlParamValue>([\n${lines.join('\n')}\n  ])`;
}

export interface EmissionOptions {
  /** Override auto-suggested id */
  readonly id?: string;
  /** Override auto-suggested matchRenderer */
  readonly matchRenderer?: RegExp;
  /** Override knownInCreepjsWhitelist (default: verify-driven) */
  readonly knownInCreepjsWhitelist?: boolean;
  /**
   * When true, emit GL constants as `0xHEX /* NAME *\/` literal pairs
   * instead of `GL.NAME` references. Used by the auto-generated
   * `webgl-profiles-captured.ts` to remain self-contained (avoids ESM
   * circular imports with `webgl-profiles.ts`). Default false — the
   * hand-paste workflow targets the file where `GL` is in scope.
   */
  readonly inlineGlKeys?: boolean;
}

export function emitProfileTypeScript(
  payload: CapturePayload,
  verify: VerifyResult,
  opts: EmissionOptions = {},
): string {
  const id = opts.id ?? suggestProfileId(verify.gpuBrand, payload.renderer);
  const match = opts.matchRenderer ?? suggestMatchRenderer(payload.renderer);
  const known = opts.knownInCreepjsWhitelist ?? verify.verdict === 'PASS';
  const constName = id
    .toUpperCase()
    .replace(/-/g, '_')
    .replace(/[^A-Z0-9_]/g, '_');

  const banner = `// ─────────────────────────────────────────────────────────────────────────────\n// ${verify.gpuBrand || '(unknown brand)'} — captured via bench/capture-real-webgl-profile.html\n//   userAgent: ${payload.userAgent}\n//   captureDate: ${payload.captureDate}\n//   capabilitiesHash: ${verify.capHash}   in whitelist? ${verify.capInWhitelist ? 'YES' : 'NO'}\n//   brandCapabilities: ${verify.brandHashValue}   in whitelist? ${verify.brandInWhitelist ? 'YES' : 'NO'}\n//   CreepJS verdict: ${verify.verdict === 'PASS' ? 'PASS (cap ∧ brand)' : 'FAIL (LowerEntropy.WEBGL)'}\n// ─────────────────────────────────────────────────────────────────────────────`;

  const inline = opts.inlineGlKeys ?? false;
  return `${banner}\n\nexport const ${constName}: WebglProfile = {\n  id: ${JSON.stringify(id)},\n  name: ${JSON.stringify(payload.renderer)},\n  matchRenderer: ${match.toString()},\n  knownInCreepjsWhitelist: ${known},\n${emitMap('webgl1', payload.webgl1, inline)},\n${emitMap('webgl2', payload.webgl2, inline)},\n};\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test (no real capture required — uses INTEL_UHD_730 hash invariant)
// ─────────────────────────────────────────────────────────────────────────────

export function selfTest(): void {
  // Build a synthetic payload mirroring INTEL_UHD_730_D3D11 (Phase 1.9b data)
  // to verify the convert pipeline produces the same capHash as the live profile.
  const payload: CapturePayload = {
    schemaVersion: 'mosaiq-webgl-capture/1',
    captureDate: '2026-05-17T00:00:00Z',
    userAgent: 'Mosaiq/self-test',
    vendor: 'Google Inc. (Intel)',
    renderer:
      'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    webgl1: {
      '0x1f00': 'WebKit',
      '0x1f01': 'WebKit WebGL',
      '0x1f02': 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      '0x8b8c': 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      '0x0b93': 0x7fffffff,
      '0x0b98': 0x7fffffff,
      '0x8ca4': 0x7fffffff,
      '0x8ca5': 0x7fffffff,
      '0x0d33': 16384,
      '0x851c': 16384,
      '0x84e8': 16384,
      '0x0d3a': [16384, 16384],
      '0x8869': 16, // MAX_VERTEX_ATTRIBS
      '0x8dfb': 4096,
      '0x8dfc': 30,
      '0x8b4c': 16,
      '0x8872': 16,
      '0x8dfd': 1024,
      '0x8b4d': 32,
      '0x846e': [1, 1],
      '0x846d': [1, 1024],
      '0x0d52': 8,
      '0x0d53': 8,
      '0x0d54': 8,
      '0x0d55': 8,
      '0x0d56': 24,
      '0x0d57': 8,
      '0x0d50': 4,
      '0x80a9': 0,
      '0x80a8': 0,
    },
    webgl2: {
      '0x1f02': 'WebGL 2.0 (OpenGL ES 3.0 Chromium)',
      '0x8b8c': 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)',
      '0x8073': 2048,
      '0x88ff': 2048,
      '0x8824': 8,
      '0x8cdf': 8,
      '0x9122': 64,
      '0x9125': 128,
      '0x8904': -8,
      '0x8905': 7,
      '0x8d57': 16,
      '0x8a2f': 60,
      '0x8a30': 65536,
      '0x8a2b': 14,
      '0x8a2d': 14,
      '0x8a2e': 28,
      '0x80e8': 1048575,
      '0x80e9': 1048575,
      '0x84fd': 15,
      '0x8b49': 16384,
      '0x8b4a': 16384,
      '0x8b4b': 124,
      '0x8c80': 4,
      '0x8c8a': 128,
      '0x8c8b': 4,
      '0x8a31': 245760,
      '0x8a33': 245760,
      '0x9111': 0,
      '0x8d6b': 0xfffffffe,
      '0x9247': 0,
    },
  };

  const verify = verifyCapture(payload);
  console.log('self-test: brand           =', verify.gpuBrand);
  console.log('self-test: capHash         =', verify.capHash);
  console.log('self-test: capInWhitelist  =', verify.capInWhitelist);
  console.log('self-test: brandHash       =', verify.brandHashValue);
  console.log('self-test: brandInWhitelist=', verify.brandInWhitelist);
  console.log('self-test: verdict         =', verify.verdict);

  // Cross-check against the live verify-creepjs-profile-hash output for
  // INTEL_UHD_730_D3D11 (Phase 4.3 v0.4-frozen value: 2146264057).
  // Bumping this constant after any KNOWN_PROFILES change is intentional —
  // the invariant we want is "convert-tool reproduces the verify-tool's hash
  // when fed equivalent input", not "hash is stable across profile edits".
  const EXPECTED_CAP_HASH = 2146264057;
  if (verify.capHash !== EXPECTED_CAP_HASH) {
    console.error(
      `self-test FAILED: capHash mismatch (got ${verify.capHash}, expected ${EXPECTED_CAP_HASH}).`,
    );
    console.error('If you intentionally changed INTEL_UHD_730_D3D11 in webgl-profiles.ts, run');
    console.error('  pnpm --filter @runova/sdk run bench:verify-creepjs');
    console.error('and update EXPECTED_CAP_HASH to match.');
    process.exit(1);
  }
  console.log('self-test ✓ capHash invariant matches verify-creepjs-profile-hash.ts');

  const emitted = emitProfileTypeScript(payload, verify);
  console.log('\nself-test emitted snippet preview (first 12 lines):');
  console.log(emitted.split('\n').slice(0, 12).join('\n'));
  console.log('  ...');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--self-test')) {
    selfTest();
    return;
  }

  const fileIdx = args.indexOf('--file');
  let raw: string;
  if (fileIdx >= 0) {
    const path = args[fileIdx + 1];
    if (!path) throw new Error('--file requires a path argument');
    raw = readFileSync(path, 'utf8');
  } else {
    raw = await readStdin();
    if (!raw.trim()) {
      console.error('No input. Pass JSON via stdin or --file <path>. Use --self-test to demo.');
      console.error(
        'Capture JSON is produced by opening bench/capture-real-webgl-profile.html in your real-hardware browser.',
      );
      process.exit(2);
    }
  }

  const payload = parseCapturePayload(raw);
  const verify = verifyCapture(payload);

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' Mosaiq · Real WebGL Profile Convert');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  console.log(`  vendor:    ${payload.vendor}`);
  console.log(`  renderer:  ${payload.renderer}`);
  console.log(`  userAgent: ${payload.userAgent}`);
  console.log(`  captureDate: ${payload.captureDate}`);
  console.log(`  WebGL1 params: ${Object.keys(payload.webgl1).length}`);
  console.log(`  WebGL2 params: ${Object.keys(payload.webgl2).length}`);
  console.log('');
  console.log(`  CreepJS gpuBrand:       "${verify.gpuBrand}"`);
  console.log(`  sortedUniqueParams (n=${verify.sortedUniqueParams.length}):`);
  console.log(`    ${verify.sortedUniqueParams.join(',')}`);
  console.log(
    `  capabilitiesHash:  ${verify.capHash}   in whitelist? ${verify.capInWhitelist ? '✓ YES' : '✗ NO'}`,
  );
  console.log(
    `  brandCapabilities: ${verify.brandHashValue}    in whitelist? ${verify.brandInWhitelist ? '✓ YES' : '✗ NO'}`,
  );
  console.log('');

  // Phase 5.4 software-renderer diagnostic — fires before the verdict so users
  // immediately understand why a brand-empty / WARP / SwiftShader / llvmpipe
  // capture is unlikely to be useful even though the convert pipeline ran clean.
  const sw = detectSoftwareRenderer(payload.renderer);
  if (sw.isSoftware) {
    console.log(
      '\x1b[33m───────────────────────────────────────────────────────────────────────────────\x1b[0m',
    );
    console.log('\x1b[33m ⚠  Software renderer detected — this is NOT real GPU hardware\x1b[0m');
    console.log(
      '\x1b[33m───────────────────────────────────────────────────────────────────────────────\x1b[0m',
    );
    console.log(`  Matched: ${sw.label}`);
    console.log('');
    console.log('  Why this matters:');
    console.log('    • CreepJS whitelists only populated from real consumer GPUs');
    console.log('      → software-fallback hashes mathematically never hit.');
    console.log('    • A Mosaiq persona claiming "Windows + modern Chrome + no GPU"');
    console.log('      is itself an unusual fingerprint that detectors like');
    console.log('      amiunique / fingerprint-scan can flag as outlier.');
    console.log('');
    console.log('  Suggested fix:');
    console.log(`    ${sw.hint}`);
    console.log('');
  }

  const verdict =
    verify.verdict === 'PASS'
      ? '\x1b[32m✓ HITS CreepJS whitelist! Setting knownInCreepjsWhitelist=true.\x1b[0m'
      : '\x1b[31m✗ MISS CreepJS whitelist (expected per Phase 2.2 math). Profile still useful for non-CreepJS detectors.\x1b[0m';
  console.log(`  Verdict: ${verdict}`);
  console.log('');

  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log(' Paste this into packages/sdk/src/injection/webgl-profiles.ts:');
  console.log('───────────────────────────────────────────────────────────────────────────────\n');
  console.log(emitProfileTypeScript(payload, verify));

  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log(' Next steps:');
  console.log('───────────────────────────────────────────────────────────────────────────────');
  console.log(' 1. Refine the suggested `id` if needed.');
  console.log(' 2. Append the constant to KNOWN_PROFILES array.');
  console.log(' 3. Add a vitest case in webgl-profiles.test.ts.');
  console.log(' 4. Re-run `bench/verify-creepjs-profile-hash.ts` to confirm the hash unchanged.');

  // Suppress unused-import lint for INT32_ARRAY_PARAMS / FLOAT32_ARRAY_PARAMS /
  // STRING_PARAMS / WebglProfile — these are re-exported for downstream
  // consumers and TS isolates dead-imports through erasure.
  void INT32_ARRAY_PARAMS;
  void FLOAT32_ARRAY_PARAMS;
  void STRING_PARAMS;
  const _wp: WebglProfile | null = null;
  void _wp;
}

// Skip auto-run when imported as a module (e.g. from tests).
// import.meta.url comparison with process.argv[1] handles both Windows / POSIX.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;

if (invokedDirectly) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
