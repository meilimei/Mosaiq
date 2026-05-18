/**
 * verify-creepjs-profile-hash.ts — Phase 4.3 验证工具
 *
 * 针对 `KNOWN_PROFILES` 中每个 WebglProfile：
 *   1. 模拟 CreepJS webgl/index.ts 的 webglParams 抽取算法
 *   2. 计算 capabilitiesHash + brandHash
 *   3. 比对 CreepJS 内置白名单
 *   4. 输出诊断报告
 *
 * Phase 4.3 预期结论：4 个 profile 全部 miss 白名单（Phase 2.2 Part 2 数学已证
 * blind hit 几率 5.5e-8）。本工具用于：
 *   - 公开报告："Mosaiq SDK 内置 GPU profile 与 CreepJS 白名单的关系"
 *   - 真机 capture 接入时复用工具验证（v0.5 真用户提交 fingerprint 后跑此工具）
 *
 * 运行：
 *   pnpm --filter @mosaiq/sdk exec tsx bench/verify-creepjs-profile-hash.ts
 */

import {
  AMD_RX_6600_D3D11,
  INTEL_UHD_630_D3D11,
  INTEL_UHD_730_D3D11,
  KNOWN_PROFILES,
  NVIDIA_RTX_3060_D3D11,
} from '../src/injection/webgl-profiles.js';
import type { WebglProfile } from '../src/injection/webgl-profiles.js';

import {
  BRAND_SET,
  CAPABILITIES_INT32,
  CAPABILITIES_SET,
  brandHash,
  capabilitiesHash,
  extractCreepjsWebglParams,
} from './creepjs-whitelist-data.js';

// ─────────────────────────────────────────────────────────────────────────────
// CreepJS getGpuBrand 复刻 —— 把 UNMASKED_RENDERER 字符串映射成 brand
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source: creepjs/src/webgl/index.ts master `getGpuBrand`。
 *
 * 关键 brand：
 *   - "Intel" / "NVIDIA" / "Apple" / "AMD" / "Google" / "Mali" / "Adreno" / 'Qualcomm' / 'PowerVR'
 *   - 兜底空字符串
 *
 * 注：我们的 INTEL_UHD_*  / NVIDIA_RTX_*  / AMD_RX_* profile 在 spoof 时仍是
 * 通过 UNMASKED_RENDERER 字符串告诉 CreepJS GPU 型号；getGpuBrand 从
 * UNMASKED_RENDERER 提取关键字 → 跟我们的 persona.gpu.webglRenderer 字符串走。
 */
function getGpuBrand(unmaskedRenderer: string): string {
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

// ─────────────────────────────────────────────────────────────────────────────
// 每个 profile 的对应 "声称的 UNMASKED_RENDERER" 字符串（与 persona template 一致）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这些字符串来自 persona-schema/templates/*.ts 的 `hardware.gpu.webglRenderer` 字段。
 * 它们就是 runner.ts §4 在 getParameter(UNMASKED_RENDERER_WEBGL=0x9246) 时返回给页面的值，
 * CreepJS getGpuBrand 用此字符串提 brand。
 */
const PROFILE_TO_RENDERER: Record<string, string> = {
  'intel-uhd-630-d3d11':
    'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'intel-uhd-730-d3d11':
    'ANGLE (Intel, Intel(R) UHD Graphics 730 (0x00004692) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'nvidia-rtx-3060-d3d11':
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'amd-rx-6600-d3d11': 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
};

// ─────────────────────────────────────────────────────────────────────────────
// Verify 单个 profile
// ─────────────────────────────────────────────────────────────────────────────

interface VerifyResult {
  readonly id: string;
  readonly name: string;
  readonly brand: string;
  readonly sortedUniqueParams: readonly number[];
  readonly capHash: number;
  readonly brandHashValue: string;
  readonly capInWhitelist: boolean;
  readonly brandInWhitelist: boolean;
  readonly creepjsResult: 'PASS' | 'FAIL (LowerEntropy.WEBGL)';
}

function verifyProfile(profile: WebglProfile): VerifyResult {
  const rendererStr = PROFILE_TO_RENDERER[profile.id] ?? profile.matchRenderer.source;
  const brand = getGpuBrand(rendererStr);

  const sortedUniqueParams = extractCreepjsWebglParams(profile.webgl1, profile.webgl2);
  const capHash = capabilitiesHash(sortedUniqueParams);
  const brandHashValue = brandHash(brand, sortedUniqueParams);

  const capInWhitelist = CAPABILITIES_SET.has(capHash);
  const brandInWhitelist = BRAND_SET.has(brandHashValue);

  return {
    id: profile.id,
    name: profile.name,
    brand,
    sortedUniqueParams,
    capHash,
    brandHashValue,
    capInWhitelist,
    brandInWhitelist,
    creepjsResult: capInWhitelist && brandInWhitelist ? 'PASS' : 'FAIL (LowerEntropy.WEBGL)',
  };
}

function nearestCapHash(target: number): { value: number; diff: number } {
  let best = CAPABILITIES_INT32[0]!;
  let bestDiff = Math.abs(target - best);
  for (const v of CAPABILITIES_INT32) {
    const d = Math.abs(target - v);
    if (d < bestDiff) {
      bestDiff = d;
      best = v;
    }
  }
  return { value: best, diff: bestDiff };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' Phase 4.3: CreepJS whitelist verification for KNOWN_PROFILES');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(`\nTotal profiles to verify: ${KNOWN_PROFILES.length}`);
  console.log(`CreepJS capabilities[] whitelist size:    ${CAPABILITIES_INT32.length}`);
  console.log(`CreepJS brandCapabilities[] whitelist size: ${BRAND_SET.size}`);

  const results: VerifyResult[] = [];
  for (const profile of KNOWN_PROFILES) {
    results.push(verifyProfile(profile));
  }

  for (const r of results) {
    console.log(
      '\n───────────────────────────────────────────────────────────────────────────────',
    );
    console.log(`Profile: ${r.id}  (${r.name})`);
    console.log(`  brand (CreepJS getGpuBrand):  "${r.brand}"`);
    console.log(`  sorted unique params (n=${r.sortedUniqueParams.length}):`);
    console.log(`    ${r.sortedUniqueParams.join(',')}`);
    console.log(
      `  capabilitiesHash:    ${r.capHash}     in whitelist? ${r.capInWhitelist ? '✓ YES' : '✗ NO'}`,
    );
    console.log(
      `  brandCapabilities:   ${r.brandHashValue}    in whitelist? ${r.brandInWhitelist ? '✓ YES' : '✗ NO'}`,
    );
    if (!r.capInWhitelist) {
      const near = nearestCapHash(r.capHash);
      console.log(`  nearest cap whitelist hash: ${near.value} (diff ${near.diff})`);
    }
    const verdict =
      r.creepjsResult === 'PASS'
        ? `\x1b[32m✓ ${r.creepjsResult}\x1b[0m`
        : `\x1b[31m✗ ${r.creepjsResult}\x1b[0m`;
    console.log(`  ⇒ creepjs.com WebGL section: ${verdict}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' Summary');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  const pass = results.filter((r) => r.creepjsResult === 'PASS');
  const fail = results.filter((r) => r.creepjsResult !== 'PASS');
  console.log(`  PASS (cap ∧ brand 都命中): ${pass.length} / ${results.length}`);
  console.log(`  FAIL (LowerEntropy.WEBGL): ${fail.length} / ${results.length}`);

  if (pass.length === 0) {
    console.log('\n⚠️  All profiles miss CreepJS whitelist — confirms Phase 2.2 Part 2 finding:');
    console.log('   CreepJS 白名单是真用户提交累积，blind hit 几率 ≈ 5.5e-8');
    console.log('   非 Mosaiq spoof 缺陷，是 CreepJS 数据库覆盖 gap');
    console.log('\n   v0.5+ 路径：建立真机 capture pipeline，让真实 UHD 630 / RTX 3060 / RX 6600');
    console.log('   用户运行 diagnose-creepjs-webgl-hash.ts 提交他们的 webglParams +');
    console.log('   capHash 验证状态，把命中白名单的 profile 标 knownInCreepjsWhitelist=true。');
  }

  // Sanity check：每个 profile 至少声称的 brand 与 PROFILE_TO_RENDERER 一致
  const intel = results.find((r) => r.id === INTEL_UHD_730_D3D11.id);
  const nvidia = results.find((r) => r.id === NVIDIA_RTX_3060_D3D11.id);
  const amd = results.find((r) => r.id === AMD_RX_6600_D3D11.id);
  const uhd630 = results.find((r) => r.id === INTEL_UHD_630_D3D11.id);
  if (intel?.brand !== 'Intel') throw new Error('UHD 730 brand mismatch');
  if (uhd630?.brand !== 'Intel') throw new Error('UHD 630 brand mismatch');
  if (nvidia?.brand !== 'NVIDIA') throw new Error('RTX 3060 brand mismatch');
  if (amd?.brand !== 'AMD') throw new Error('RX 6600 brand mismatch');
  console.log('\nSanity ✓ all brand strings correctly classified by getGpuBrand');
}

main();
