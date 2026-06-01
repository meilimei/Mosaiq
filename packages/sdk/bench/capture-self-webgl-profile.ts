/// <reference types="node" />
/**
 * capture-self-webgl-profile.ts — Phase 7.1
 *
 * Drives `bench/capture-real-webgl-profile.html` through a headed
 * Playwright Chromium to extract THIS machine's real WebGL profile,
 * then saves the JSON into `bench/captured-profiles/`. Runs without
 * any manual UI clicks: the capture page auto-runs on load and writes
 * its JSON payload into `#output`; we just `waitForFunction` the
 * textarea is non-empty and read it back.
 *
 * Why headed Chromium:
 *   Playwright's Chromium uses ANGLE+D3D11 on Windows (same as
 *   system Chrome), but only when running headed. Headless mode
 *   forces SwiftShader (software fallback) → captures would be
 *   detected as software-rendered by Phase 5.4b's detector and
 *   rejected. Headed mode briefly opens a window; that's a fair
 *   one-shot trade for a real-hardware capture.
 *
 * No spoof injection: this is a vanilla Playwright launch — we
 * deliberately do NOT call into Mosaiq's injection pipeline. The
 * capture must reflect the host hardware, not Mosaiq's persona.
 *
 * Run:
 *   pnpm --filter @runova/sdk run bench:capture-self
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import {
  detectSoftwareRenderer,
  parseCapturePayload,
  suggestProfileId,
  verifyCapture,
} from './convert-captured-profile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE_HTML = resolve(HERE, 'capture-real-webgl-profile.html');
const PROFILES_DIR = resolve(HERE, 'captured-profiles');

function fileUrl(path: string): string {
  // Cross-platform file:// URL builder. On Windows the resolved path
  // is `D:\foo\bar`; URL needs `file:///D:/foo/bar`.
  const norm = path.replace(/\\/g, '/');
  return norm.startsWith('/') ? `file://${norm}` : `file:///${norm}`;
}

function suggestFilename(brand: string, renderer: string, suffix = 'self'): string {
  // Reuse the single source of truth from convert-captured-profile so the
  // filename stem matches what `integrate-captured-profiles.deriveIdentity`
  // would produce for an ad-hoc filename — keeps the contributor pipeline
  // visually consistent (e.g. `intel-hd-520-d3d11-self.json`).
  const id = suggestProfileId(brand, renderer);
  return `${id}-${suffix}.json`;
}

async function main(): Promise<void> {
  if (!existsSync(CAPTURE_HTML)) {
    throw new Error(`capture HTML not found: ${CAPTURE_HTML}`);
  }
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });

  console.log('[capture-self] launching headed Chromium...');
  const browser = await chromium.launch({
    headless: false,
    // No GPU-disabling flags; Playwright's Chromium picks ANGLE+D3D11
    // on Windows / Metal on macOS / OpenGL on Linux when headed.
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const url = fileUrl(CAPTURE_HTML);
    console.log(`[capture-self] navigating to ${url}`);
    await page.goto(url, { waitUntil: 'load' });

    // Capture HTML auto-runs `runCapture()` on DOMContentLoaded and
    // writes the JSON to #output. Wait until #output is populated
    // and parses cleanly.
    console.log('[capture-self] waiting for #output JSON...');
    await page.waitForFunction(
      () => {
        const ta = document.querySelector<HTMLTextAreaElement>('#output');
        if (!ta || !ta.value) return false;
        try {
          const parsed = JSON.parse(ta.value) as { schemaVersion?: string };
          return parsed.schemaVersion === 'mosaiq-webgl-capture/1';
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    );

    const json = await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('#output');
      return ta?.value ?? '';
    });

    // Validate locally before writing — refuse software-renderer captures
    const payload = parseCapturePayload(json);
    const sw = detectSoftwareRenderer(payload.renderer);
    if (sw.isSoftware) {
      console.error(
        `[capture-self] ❌ software renderer detected: ${sw.label}\n[capture-self]    ${sw.hint}\n[capture-self] not writing JSON. Re-run with hardware acceleration enabled.`,
      );
      process.exit(3);
    }

    const verify = verifyCapture(payload);
    console.log('');
    console.log(`[capture-self] vendor:    ${payload.vendor}`);
    console.log(`[capture-self] renderer:  ${payload.renderer}`);
    console.log(`[capture-self] gpuBrand:  ${verify.gpuBrand}`);
    console.log(`[capture-self] capHash:   ${verify.capHash}`);
    console.log(`[capture-self] brandHash: ${verify.brandHashValue}`);
    console.log(
      `[capture-self] verdict:   ${
        verify.verdict === 'PASS'
          ? '✅ PASS (cap ∧ brand both in CreepJS whitelist)'
          : '❌ FAIL (CreepJS whitelist miss — profile is still useful for non-CreepJS detectors)'
      }`,
    );
    console.log('');

    const filename = suggestFilename(verify.gpuBrand, payload.renderer);
    const outPath = resolve(PROFILES_DIR, filename);
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`[capture-self] wrote ${outPath}`);
    console.log('[capture-self] next:');
    console.log('[capture-self]   pnpm --filter @runova/sdk run bench:integrate-profiles');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[capture-self] FAILED: ${(err as Error).message}`);
  process.exit(2);
});
