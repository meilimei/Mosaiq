/**
 * convert-captured-profile.test.ts — Phase 5.3 test coverage
 *
 * Tests the pure helpers (parse / verify / suggest / emit). The CLI entry
 * point itself is exercised by manual `--self-test`. We exercise the same
 * INTEL_UHD_730 invariant here through the importable API so any regression
 * shows up in CI.
 */

import { describe, expect, it } from 'vitest';

import {
  buildParamMap,
  detectSoftwareRenderer,
  emitProfileTypeScript,
  getGpuBrand,
  parseCapturePayload,
  suggestMatchRenderer,
  suggestProfileId,
  verifyCapture,
  type CapturePayload,
} from './convert-captured-profile.js';
import { extractCreepjsWebglParams, capabilitiesHash } from './creepjs-whitelist-data.js';
import { INTEL_UHD_730_D3D11 } from '../src/injection/webgl-profiles.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: synthesize a CapturePayload from a live WebglProfile so the test is
// independent of any hardcoded JSON snapshot.
// ─────────────────────────────────────────────────────────────────────────────

function profileToPayload(
  profile: typeof INTEL_UHD_730_D3D11,
  renderer: string,
): CapturePayload {
  const toRecord = (
    m: ReadonlyMap<number, number | readonly number[] | string>,
  ): Record<string, number | readonly number[] | string> => {
    const out: Record<string, number | readonly number[] | string> = {};
    for (const [k, v] of m) {
      out['0x' + k.toString(16).padStart(4, '0')] = v;
    }
    return out;
  };
  return {
    schemaVersion: 'mosaiq-webgl-capture/1',
    captureDate: '2026-05-17T00:00:00Z',
    userAgent: 'vitest-test',
    vendor: 'Google Inc. (Intel)',
    renderer,
    webgl1: toRecord(profile.webgl1),
    webgl2: toRecord(profile.webgl2),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseCapturePayload
// ─────────────────────────────────────────────────────────────────────────────

describe('parseCapturePayload', () => {
  it('parses a well-formed capture', () => {
    const raw = JSON.stringify({
      schemaVersion: 'mosaiq-webgl-capture/1',
      captureDate: '2026-05-17T00:00:00Z',
      userAgent: 'test',
      vendor: 'V',
      renderer: 'R',
      webgl1: { '0x0d33': 16384 },
      webgl2: {},
    });
    const p = parseCapturePayload(raw);
    expect(p.vendor).toBe('V');
    expect(p.renderer).toBe('R');
  });

  it('rejects unsupported schemaVersion', () => {
    const raw = JSON.stringify({
      schemaVersion: 'mosaiq-webgl-capture/2',
      captureDate: '',
      userAgent: '',
      vendor: '',
      renderer: '',
      webgl1: {},
      webgl2: {},
    });
    expect(() => parseCapturePayload(raw)).toThrow(/schemaVersion/);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseCapturePayload('{not json')).toThrow(/JSON/);
  });

  it('rejects missing renderer/vendor', () => {
    const raw = JSON.stringify({
      schemaVersion: 'mosaiq-webgl-capture/1',
      captureDate: '',
      userAgent: '',
      webgl1: {},
      webgl2: {},
    });
    expect(() => parseCapturePayload(raw)).toThrow(/renderer/);
  });

  it('rejects missing webgl1', () => {
    const raw = JSON.stringify({
      schemaVersion: 'mosaiq-webgl-capture/1',
      captureDate: '',
      userAgent: '',
      vendor: 'V',
      renderer: 'R',
      webgl2: {},
    });
    expect(() => parseCapturePayload(raw)).toThrow(/webgl1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildParamMap
// ─────────────────────────────────────────────────────────────────────────────

describe('buildParamMap', () => {
  it('converts hex keys to numbers', () => {
    const m = buildParamMap({ '0x0d33': 16384, '0x0d3a': [16384, 16384] });
    expect(m.get(0x0d33)).toBe(16384);
    expect(m.get(0x0d3a)).toEqual([16384, 16384]);
  });

  it('throws on invalid hex key', () => {
    expect(() => buildParamMap({ '16384': 16384 })).toThrow(/Invalid hex key/);
    expect(() => buildParamMap({ '0xZZZZ': 1 })).toThrow(/Invalid hex key/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getGpuBrand
// ─────────────────────────────────────────────────────────────────────────────

describe('getGpuBrand', () => {
  it('classifies common GPU brands', () => {
    expect(getGpuBrand('ANGLE (Intel, Intel(R) UHD Graphics 730 ...)')).toBe('Intel');
    expect(getGpuBrand('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 ...)')).toBe('NVIDIA');
    expect(getGpuBrand('ANGLE (AMD, AMD Radeon RX 6600 ...)')).toBe('AMD');
    expect(getGpuBrand('ANGLE (Apple, Apple M2, ...)')).toBe('Apple');
    expect(getGpuBrand('ANGLE (Google, SwiftShader, ...)')).toBe('Google');
    expect(getGpuBrand('Adreno (TM) 650')).toBe('Qualcomm');
    expect(getGpuBrand('Mali-G78')).toBe('Mali');
    expect(getGpuBrand('PowerVR GE8320')).toBe('PowerVR');
  });

  it('returns empty for unknown brand', () => {
    expect(getGpuBrand('Unknown VGA')).toBe('');
    expect(getGpuBrand('')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectSoftwareRenderer — Phase 5.4 diagnostic for hardware-acceleration off
// ─────────────────────────────────────────────────────────────────────────────

describe('detectSoftwareRenderer', () => {
  it('detects Microsoft Basic Render Driver (Windows D3D11 WARP)', () => {
    // 真实 capture 来自 Edge 关闭硬件加速时的 ANGLE WARP fallback。
    const result = detectSoftwareRenderer(
      'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    );
    expect(result.isSoftware).toBe(true);
    expect(result.label).toMatch(/Microsoft Basic Render Driver/);
    expect(result.hint).toMatch(/edge:\/\/settings\/system|chrome:\/\/settings\/system/);
  });

  it('detects SwiftShader (Chromium portable CPU GL)', () => {
    const result = detectSoftwareRenderer('ANGLE (Google, SwiftShader Device, ...)');
    expect(result.isSoftware).toBe(true);
    expect(result.label).toMatch(/SwiftShader/);
    expect(result.hint).toMatch(/hardware acceleration|GPU/i);
  });

  it('detects Mesa llvmpipe (Linux software driver)', () => {
    const result = detectSoftwareRenderer('Mesa Intel(R) llvmpipe (LLVM 17.0.6, 256 bits)');
    expect(result.isSoftware).toBe(true);
    expect(result.label).toMatch(/llvmpipe/);
    expect(result.hint).toMatch(/glxinfo|drivers/i);
  });

  it('detects generic "Software Rasterizer" string', () => {
    const result = detectSoftwareRenderer('Generic Software Rasterizer');
    expect(result.isSoftware).toBe(true);
    expect(result.label).toMatch(/software/i);
  });

  it('does NOT flag real Intel iGPU as software', () => {
    const result = detectSoftwareRenderer(
      'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    );
    expect(result.isSoftware).toBe(false);
    expect(result.label).toBe('');
    expect(result.hint).toBe('');
  });

  it('does NOT flag real NVIDIA / AMD / Apple GPUs as software', () => {
    expect(
      detectSoftwareRenderer(
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ).isSoftware,
    ).toBe(false);
    expect(
      detectSoftwareRenderer('ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)')
        .isSoftware,
    ).toBe(false);
    expect(detectSoftwareRenderer('Apple M2').isSoftware).toBe(false);
  });

  it('does NOT confuse "Software Rasterizer" with brand names containing the substring', () => {
    // The real "MicroSoft Software Inc." would be a corporate string but
    // word-boundary anchored regex should still match it as software.
    // More importantly: ensure a NVIDIA renderer that mentions "software"
    // pipeline elsewhere wouldn't false-positive — currently we rely on the
    // regex's word-boundary; this test pins a representative known-good
    // string to prevent regression if regex is loosened.
    expect(
      detectSoftwareRenderer(
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ).isSoftware,
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyCapture — round-trip invariant against extractCreepjsWebglParams
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyCapture', () => {
  it('reproduces the canonical capHash for INTEL_UHD_730 round-trip', () => {
    // The crucial invariant: convert tool seeing the same data as
    // verify-creepjs-profile-hash.ts must compute the same capHash.
    const payload = profileToPayload(
      INTEL_UHD_730_D3D11,
      'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    );
    const verify = verifyCapture(payload);
    // Direct hash via the library (avoids hardcoding the magic number — if
    // KNOWN_PROFILES changes, this test still passes as long as round-trip works)
    const expectedHash = capabilitiesHash(
      extractCreepjsWebglParams(INTEL_UHD_730_D3D11.webgl1, INTEL_UHD_730_D3D11.webgl2),
    );
    expect(verify.capHash).toBe(expectedHash);
  });

  it('classifies the brand correctly for an Intel renderer', () => {
    const payload = profileToPayload(
      INTEL_UHD_730_D3D11,
      'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    );
    expect(verifyCapture(payload).gpuBrand).toBe('Intel');
  });

  it('reports FAIL when neither hash hits whitelist (real-world expectation)', () => {
    // INTEL_UHD_730 is known to miss CreepJS whitelist (Phase 2.2 math), so
    // verdict must be FAIL — confirms the tool surfaces the negative result.
    const payload = profileToPayload(
      INTEL_UHD_730_D3D11,
      'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    );
    expect(verifyCapture(payload).verdict).toBe('FAIL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// suggestProfileId / suggestMatchRenderer
// ─────────────────────────────────────────────────────────────────────────────

describe('suggestProfileId', () => {
  it('extracts NVIDIA RTX models', () => {
    expect(
      suggestProfileId(
        'NVIDIA',
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ),
    ).toBe('nvidia-rtx-4090-d3d11');
  });

  it('extracts AMD RX models', () => {
    expect(
      suggestProfileId(
        'AMD',
        'ANGLE (AMD, AMD Radeon RX 7900 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ),
    ).toBe('amd-rx-7900-d3d11');
  });

  it('extracts Intel UHD models', () => {
    expect(
      suggestProfileId(
        'Intel',
        'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ),
    ).toBe('intel-uhd-770-d3d11');
  });

  it('extracts Apple M-series with Metal backend', () => {
    expect(
      suggestProfileId(
        'Apple',
        'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
      ),
    ).toBe('apple-m2-metal');
  });

  it('falls back to unknown when no model token matches', () => {
    expect(suggestProfileId('Intel', 'Unrecognized GPU XYZ123')).toBe(
      'intel-unknown-unknown',
    );
  });
});

describe('suggestMatchRenderer', () => {
  it('produces a word-boundary regex matching the model token', () => {
    const r = suggestMatchRenderer(
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    );
    expect(r.test('ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 ...)')).toBe(true);
    expect(r.test('ANGLE (NVIDIA, NVIDIA GeForce RTX 4090Ti ...)')).toBe(false);
    expect(r.test('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 ...)')).toBe(false);
  });

  it('matches case-insensitively', () => {
    const r = suggestMatchRenderer('Apple M2 Max');
    expect(r.test('apple m2')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// emitProfileTypeScript
// ─────────────────────────────────────────────────────────────────────────────

describe('emitProfileTypeScript', () => {
  it('emits a paste-ready WebglProfile snippet', () => {
    const payload = profileToPayload(
      INTEL_UHD_730_D3D11,
      'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    );
    const verify = verifyCapture(payload);
    const out = emitProfileTypeScript(payload, verify);

    expect(out).toContain('export const INTEL_UHD_730_D3D11: WebglProfile');
    expect(out).toContain('webgl1: new Map<number, GlParamValue>');
    expect(out).toContain('webgl2: new Map<number, GlParamValue>');
    // Should use GL.* constants where possible
    expect(out).toContain('GL.MAX_TEXTURE_SIZE');
    expect(out).toContain('GL.MAX_VIEWPORT_DIMS');
    // String params kept as JSON strings
    expect(out).toContain('"WebGL 1.0 (OpenGL ES 2.0 Chromium)"');
    // matchRenderer is a regex literal, not a JSON-quoted string
    expect(out).toMatch(/matchRenderer: \/.*\/i?,/);
    // knownInCreepjsWhitelist reflects the verify verdict (false for UHD 730)
    expect(out).toContain('knownInCreepjsWhitelist: false');
  });

  it('honors overrides via EmissionOptions', () => {
    const payload = profileToPayload(
      INTEL_UHD_730_D3D11,
      'ANGLE (Intel, Intel(R) UHD Graphics 730 ...)',
    );
    const verify = verifyCapture(payload);
    const out = emitProfileTypeScript(payload, verify, {
      id: 'custom-id-x',
      matchRenderer: /CustomRegex/,
      knownInCreepjsWhitelist: true,
    });
    expect(out).toContain('export const CUSTOM_ID_X');
    expect(out).toContain('"custom-id-x"');
    expect(out).toContain('matchRenderer: /CustomRegex/');
    expect(out).toContain('knownInCreepjsWhitelist: true');
  });

  it('uses hex literal for unmapped GL constants', () => {
    const payload: CapturePayload = {
      schemaVersion: 'mosaiq-webgl-capture/1',
      captureDate: '2026-05-17T00:00:00Z',
      userAgent: 'vitest',
      vendor: '',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 730 ...)',
      // 0x9999 is not in our GL constants map → must fall back to hex literal
      webgl1: { '0x9999': 42 },
      webgl2: {},
    };
    const verify = verifyCapture(payload);
    const out = emitProfileTypeScript(payload, verify);
    expect(out).toContain('[0x9999, 42]');
  });
});
