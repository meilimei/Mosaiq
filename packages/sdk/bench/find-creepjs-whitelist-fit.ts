/**
 * find-creepjs-whitelist-fit.ts — Phase 2.2 Part 2 reverse-fit tool
 *
 * 目标：以 INTEL_UHD_630/730 D3D11 profile 的 webglParams 集合为起点，枚举
 * "修改 1 个值" 的所有可能，找到能让两个 CreepJS WebGL 白名单 hashes 同时
 * 命中的最小代价改动。
 *
 * CreepJS 触发 LowerEntropy.WEBGL 的两条独立 check：
 *   1. capabilitiesHash = webglParams.reduce((acc, v, i) => acc ^ (v + i), 0)
 *      必须 ∈ capabilities[] (254 个 int32 hash)
 *   2. brandCapabilities = hashMini([gpuBrand, webglParamsStr])
 *      必须 ∈ brandCapabilities[] (270 个 hex hashMini)
 *
 * 两条都命中 = bold-fail 消失。一条 miss = LowerEntropy.WEBGL = true。
 *
 * 数据源：creepjs/src/webgl/index.ts master (commit hash 见 PHASE-2-PLAN.md)
 *
 * 运行：tsx packages/sdk/bench/find-creepjs-whitelist-fit.ts
 *
 * 输出：所有 hit 的 (param_index, old_value, new_value, capHash, brandHash) 三元组。
 *      若无 hit，输出"最近距离"（哪个候选 cap hash 与白名单最近的 hash 差值最小）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// CreepJS whitelist data (literal copy from creepjs/src/webgl/index.ts master)
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITIES_INT32: readonly number[] = [
  -1056897629, -1056946782, -1073719331, -1147160399, -1147160553, -1147168724, -1147419751,
  -1147419753, -1147419775, -1147427826, -1147451883, -1147451901, -1147464169, -1147464177,
  -1147488144, -1147602934, -1147643759, -1147643872, -1147765274, -1148326739, -1148335070,
  -1148572354, -1148678631, -1148680509, -1148713259, -1164279890, -1164800191, -1164800478,
  -1332029332, -133757475, -1342154787, -134823971, -16746546, -1878102921, -1878111124,
  -1962893370, -1962919974, -1962928178, -2130164162, -2130164382, -2130164388, -2130164546,
  -2130172573, -2130659912, -2145933648, -2145941977, -2145958228, -2145966414, -2145966441,
  -2145966529, -2145966535, -2145966545, -2145970658, -2145974343, -2145974380, -2145974489,
  -2145974596, -2145974598, -2145974612, -2145974637, -2145974657, -2145974729, -2146187766,
  -2146232338, -2146232480, -2146232503, -2146232590, -2146232723, -2146232724, -2146236588,
  -2146236703, -2146237020, -2146251619, -2146251641, -2146251681, -2146253671, -2146253693,
  -2146277218, -2146286438, -2146286463, -2146286583, -2146319268, -2146376065, -2146379955,
  -2146384003, -2146384011, -2146384027, -2146384034, -2146384120, -2146384281, -2146398568,
  -2146400384, -2146400556, -2146400620, -2146401928, -2146417027, -2146526795, -2146526934,
  -2147125544, -2147128275, -2147133747, -2147133749, -2147133760, -2147134974, -2147136328,
  -2147142429, -2147287810, -2147287811, -2147287820, -2147287834, -2147287835, -2147287854,
  -2147291718, -2147291820, -2147293058, -2147295768, -2147295822, -2147295823, -2147295849,
  -2147295857, -2147300019, -2147304193, -2147304219, -2147306321, -2147316382, -2147316383,
  -2147333118, -2147336998, -2147337003, -2147337012, -2147337022, -2147344686, -2147346747,
  -2147361652, -2147361731, -2147361769, -2147361774, -2147361775, -2147361778, -2147361792,
  -2147362760, -2147365698, -2147365730, -2147365759, -2147365760, -2147365827, -2147365863,
  -2147373914, -2147373984, -2147374032, -2147374080, -2147378041, -2147378146, -2147382130,
  -2147382221, -2147382251, -2147382270, -2147382272, -2147383246, -2147385825, -2147385849,
  -2147386292, -2147386326, -2147387335, -2147387364, -2147389930, -2147389937, -2147389951,
  -2147390461, -2147394188, -2147394251, -2147394484, -2147400057, -2147406798, -2147407643,
  -2147407821, -2147410938, -2147410941, -2147414733, -2147414956, -2147414987, -2147415037,
  -2147429201, -2147429223, -2147439020, -2147440422, -2147447111, -2147447122, -2147447126,
  -2147447137, -2147447149, -2147447157, -2147447161, -2147447163, -2147447873, -2147447892,
  -2147447896, -2147447928, -2147448592, -2147453701, -2147453767, -2147453768, -2147459031,
  -2147461169, -2147466956, -2147466972, -2147467172, -2147470173, -2147475351, -2147475352,
  -638494755, -671082546, -677558160, -999987216, 1099536, 1099644, 1147714426, 1197075, 1229835,
  1508998, 1509050, 1610618841, 184555483, 2146590728, 2147305224, 2147361749, 2147440438,
  2147475085, 2147479181, 21667, 349912, 351513, 83625, 998804992, 998911268, 999148597, 999156922,
];

const BRAND_CAPABILITIES_HEX: readonly string[] = [
  '00b72507', '00c1b42d', '00fe1ec9', '02b3eea3', '0461d3de', '0463627d', '057857ac', '0586e20b',
  '0639a81a', '087d5759', '08847ba5', '0b2d4333', '0cdb985d', '0e058699', '0eb2fc19', '0f39d057',
  '0f840379', '0fc123c7', '101e0582', '12e92e62', '12f8ac14', '1453d59a', '149a1efa', '166dc7c8',
  '16c481a6', '171831c5', '177cc258', '18579e83', '19594666', '1b251fd7', '1bfd326c', '1e8a9a79',
  '1ff7c7e7', '2048bc5a', '2259b706', '22d0f2cf', '230d6a0d', '23d1ce20', '2402c3d2', '24306836',
  '258789d0', '25a760b8', '25f9385d', '27938830', '27db292c', '2b80fd96', '2bb488da', '2c04c2eb',
  '2d15287f', '2f014c41', '2f582ed9', '300ee927', '33bc5492', '34270469', '3660b71f', '3740c4c7',
  '3999a5e1', '39ead506', '3a91d0d6', '3b724916', '3bf321b8', '3c546144', '3f9ef44c', '3fea1100',
  '3ff82303', '4027d193', '402e1064', '4065cd69', '43038e3d', '4503e771', '461f97e1', '464d51ac',
  '467b99a5', '482c81b2', '48af038f', '4962ada1', '49bf7358', '4c9e8f5d', '502c402c', '508d1625',
  '52e348ba', '534002ab', '5582debe', '55d3aa56', '55e821f7', '581f3282', '5831d5fd', '58871380',
  '58fdc720', '5a5658f1', '5a90a5f8', '5aea1af1', '5b6a17aa', '5bef9a39', '5ca55292', '5d786cef',
  '5ddb9237', '5ee41456', '61178f2a', '61ca8e23', '61d9464e', '61eecaae', '623c3bfd', '6248d9e3',
  '6294d84e', '62bf7ef1', '6346cf49', '6357365c', '66628310', '668f0f93', '66d992e8', '67995996',
  '6843ebbf', '6864dcb0', '6951838b', '696e1548', '698c5c2e', '6a75ae3b', '6aa1ff7e', '6b07d4f8',
  '6b290cd4', '6c168801', '6dfae3cb', '6e806ffc', '6edf1720', '6f81cbe7', '70859bdb', '70a095b1',
  '7238c5dd', '7360ebd1', '741688e4', '74daf866', '78640859', '79284c47', '794f8929', '795e5c95',
  '79a57aa9', '7aa13573', '7b2e5242', '7b811cdd', '7ec0ea6b', '801d73af', '802e2547', '81b9cd29',
  '8219e1a4', '82a9a2f1', '8428fc8e', '849ccb64', '8541aa4c', '85479b99', '8bd0b91b', '8d371161',
  '903c8847', '917871e7', '98aeaba9', '99b1a1c6', '99ef2c3b', '9b67b7dc', '9c6df98c', '9c814c1b',
  '9e2b5e94', '9fd76352', 'a1c808d5', 'a22788f8', 'a2383001', 'a26e9aa9', 'a397a568', 'a3f9ee34',
  'a4b988da', 'a4d34176', 'a581f55e', 'a5a477ae', 'a9640880', 'a97d3858', 'aa73f3a4', 'ab40bece',
  'ac4d4ba8', 'ad01a422', 'ade75c4f', 'ae2c4777', 'afa583bc', 'b10c2a85', 'b224cc7c', 'b2d6fc98',
  'b362c2f5', 'b467620a', 'b4d40dcc', 'b504662d', 'b50edd99', 'b5494027', 'b62321c3', 'b8961d15',
  'b8ea6e7f', 'bb77a469', 'bc0f9686', 'bcf7315f', 'be2dfaea', 'beffda26', 'bf06317e', 'bf610cdb',
  'bfe1c212', 'c00582e9', 'c026469d', 'c04889b1', 'c04b0635', 'c04e374a', 'c05f7596', 'c07307c6',
  'c092fdf8', 'c25dd065', 'c2bce496', 'c5e9a883', 'c79634c2', 'c7e37ca0', 'c93b5366', 'c9bc4ffd',
  'cba1878b', 'cbeade8c', 'ce2e3d16', 'cefb72ca', 'cf9643e6', 'cfd20274', 'd05a66eb', 'd09c1c07',
  'd1e76c89', 'd2172943', 'd2dc2474', 'd498797d', 'd6bf35ad', 'd734ea08', 'd860ff42', 'd8bd9e5a',
  'd913dafa', 'd970d345', 'dbdbe7a4', 'dc271c35', 'dcd9a29e', 'dd67b076', 'de793ead', 'ded74044',
  'df9daeb6', 'e10339b3', 'e142d1f9', 'e155c47e', 'e15afab0', 'e16bb1bb', 'e316e4c0', 'e3eff92a',
  'e4569a5b', 'e574bef6', 'e5962ba3', 'e6464c9f', 'e68b5c4e', 'e796b84e', 'e8694547', 'e965d180',
  'e965d541', 'e9bdc904', 'e9dbb8d5', 'ea54d525', 'ea59b343', 'ea7f90ea', 'ea8f5ad0', 'eaa13804',
  'eb799d34', 'ec050bb6', 'ec928655', 'eed2e5e1', 'ef8f5db1', 'f0d5a3c7', 'f1077334', 'f221fef5',
  'f2293447', 'f33d918e', 'f3c6ea11', 'f51056a1', 'f51cab9a', 'f573bb34', 'f5d19934', 'f7451c92',
  'f8e65486', 'f9714b3d', 'fa994f33', 'fafa14c0', 'fc37fe1f', 'fca66520', 'fe0997b6',
];

const CAPABILITIES_SET = new Set(CAPABILITIES_INT32);
const BRAND_SET = new Set(BRAND_CAPABILITIES_HEX);

// ─────────────────────────────────────────────────────────────────────────────
// CreepJS hash algorithms (literal copy from creepjs/src/utils/crypto.ts master)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * hashMini — FNV-prime-style hash with djb2-31 multiplication; produces 8-char hex.
 * Source: creepjs/src/utils/crypto.ts master.
 */
function hashMini(x: unknown): string {
  const json = `${JSON.stringify(x)}`;
  const hash = json.split('').reduce((h, _char, i) => {
    return (Math.imul(31, h) + json.charCodeAt(i)) | 0;
  }, 0x811c9dc5);
  return ('0000000' + (hash >>> 0).toString(16)).substr(-8);
}

/** capabilitiesHash = webglParams.reduce((acc, v, i) => acc ^ (v + i), 0) */
function capabilitiesHash(sortedUniqueParams: readonly number[]): number {
  return sortedUniqueParams.reduce((acc, v, i) => acc ^ ((v + i) | 0), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline: UHD 730/630 D3D11 webglParams set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 来源：bench/diagnose-creepjs-webgl-hash.ts 在 win11-chrome-us 真机 (Intel UHD 730)
 * 上 capture 的 webglParams sorted unique numeric set。
 *
 * UHD 630 与 UHD 730 共享 ANGLE D3D11 backend → 应有相同 sorted set。
 *
 * CreepJS webglParams 计算逻辑：
 *   Object.values(parameters).filter(v => v && typeof v != 'string').flat().map(Number)
 *   → new Set(...).sort((a, b) => a - b)
 *
 * 注：0 被 `val && ...` filter 掉，所以 SAMPLES/SAMPLE_BUFFERS/MAX_SERVER_WAIT_TIMEOUT/
 * MAX_CLIENT_WAIT_TIMEOUT_WEBGL 这些 0 值不在数组中。
 */
const BASELINE_PARAMS: readonly number[] = [
  1, 4, 6, 7, 8, 10, 14, 15, 16, 23, 28, 30, 31, 32, 60, 64, 124, 127, 128, 1024, 2048, 4096, 16384,
  65536, 245760, 1048575, 2147483647, 4294967294,
];

const GPU_BRAND = 'Intel'; // CreepJS getGpuBrand() 对 UNMASKED_RENDERER_WEBGL 含 "Intel" 字符串返回

// ─────────────────────────────────────────────────────────────────────────────
// Plausible alternate values for Intel iGPU webgl caps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 候选替换值池。原则：
 *  - 必须是已知 GL spec 限制内的合法值
 *  - 优先 power-of-2 / 常见 driver 差异点 / 不同 D3D feature level 报告值
 *  - 避免明显跨 GPU 的离谱值（如 32768 仅 NVIDIA Maxwell+ 报告）
 *
 * 包含 BASELINE_PARAMS 全部值（让 "replace with existing" 触发 dedup → 数组长度变化）。
 */
const PLAUSIBLE_ALTS: readonly number[] = [
  // —— 小整数（bit counts / texture units） ——
  0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 36, 40, 48, 56, 60, 64, 72, 80, 84, 96, 108, 112, 124, 127, 128, 144, 160,
  192, 224, 240, 252, 256,
  // —— 中等整数 ——
  384, 480, 504, 512, 768, 960, 1008, 1024, 1280, 1536, 1920, 2016, 2048, 2304, 3072, 3840, 4032,
  4096, 6144, 7680, 8064, 8192, 12288, 15360, 16128, 16384, 24576, 30720, 32256, 32768,
  // —— 大整数（buffer / element / timeout） ——
  49152, 61440, 64512, 65536, 122880, 131072, 245760, 262144, 491520, 524288, 1048575, 1048576,
  2097151, 2097152, 4194303, 4194304, 8388607, 8388608, 16777215, 16777216, 33554431, 33554432,
  // —— int32 边界 ——
  0x7ffffffe, 0x7fffffff, 0x80000000 - 1, 2147483647, 4294967294, 4294967295,
];

// ─────────────────────────────────────────────────────────────────────────────
// Main search
// ─────────────────────────────────────────────────────────────────────────────

interface Hit {
  readonly description: string;
  readonly newParams: readonly number[];
  readonly capHash: number;
  readonly brandHash: string;
  readonly capInWhitelist: boolean;
  readonly brandInWhitelist: boolean;
}

function tryParams(newParams: readonly number[], description: string): Hit {
  const sorted = [...new Set(newParams)].sort((a, b) => a - b);
  const capHash = capabilitiesHash(sorted);
  const brandHash = hashMini([GPU_BRAND, '' + sorted]);
  return {
    description,
    newParams: sorted,
    capHash,
    brandHash,
    capInWhitelist: CAPABILITIES_SET.has(capHash),
    brandInWhitelist: BRAND_SET.has(brandHash),
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

function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' Phase 2.2 Part 2: CreepJS WebGL whitelist reverse-fit');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  // Baseline
  const baseline = tryParams(BASELINE_PARAMS, 'baseline UHD 730/630 (no change)');
  console.log('\nBaseline:');
  console.log(`  params (sorted): ${baseline.newParams.join(',')}`);
  console.log(`  capHash:         ${baseline.capHash} (in whitelist: ${baseline.capInWhitelist})`);
  console.log(`  brandHash:       ${baseline.brandHash} (in whitelist: ${baseline.brandInWhitelist})`);

  const baselineNearest = nearestCapHash(baseline.capHash);
  console.log(`  nearest cap whitelist hash: ${baselineNearest.value} (diff ${baselineNearest.diff})`);

  if (baseline.capInWhitelist && baseline.brandInWhitelist) {
    console.log('\n✓ Baseline already in both whitelists — no fitting needed.');
    return;
  }

  // Enumerate single-replace changes
  const hits: Hit[] = [];
  const partialHits: Hit[] = []; // 命中 capabilities[] 但 miss brandCapabilities，或反之

  let totalTries = 0;
  for (let i = 0; i < BASELINE_PARAMS.length; i++) {
    for (const newVal of PLAUSIBLE_ALTS) {
      const oldVal = BASELINE_PARAMS[i]!;
      if (newVal === oldVal) continue;
      const modified = [...BASELINE_PARAMS];
      modified[i] = newVal;
      const hit = tryParams(modified, `replace [${i}]=${oldVal} → ${newVal}`);
      totalTries++;
      if (hit.capInWhitelist && hit.brandInWhitelist) hits.push(hit);
      else if (hit.capInWhitelist || hit.brandInWhitelist) partialHits.push(hit);
    }
  }

  // Single-add (length 28 → 29)
  for (const newVal of PLAUSIBLE_ALTS) {
    if (BASELINE_PARAMS.includes(newVal)) continue;
    const modified = [...BASELINE_PARAMS, newVal];
    const hit = tryParams(modified, `add ${newVal}`);
    totalTries++;
    if (hit.capInWhitelist && hit.brandInWhitelist) hits.push(hit);
    else if (hit.capInWhitelist || hit.brandInWhitelist) partialHits.push(hit);
  }

  // Single-delete (length 28 → 27)
  for (let i = 0; i < BASELINE_PARAMS.length; i++) {
    const removed = BASELINE_PARAMS[i]!;
    const modified = BASELINE_PARAMS.filter((_, j) => j !== i);
    const hit = tryParams(modified, `delete [${i}]=${removed}`);
    totalTries++;
    if (hit.capInWhitelist && hit.brandInWhitelist) hits.push(hit);
    else if (hit.capInWhitelist || hit.brandInWhitelist) partialHits.push(hit);
  }

  console.log(`\nSearched ${totalTries} single-change permutations`);
  console.log(`  Full hits (both whitelists):    ${hits.length}`);
  console.log(`  Partial hits (one whitelist):   ${partialHits.length}`);

  if (hits.length > 0) {
    console.log('\n═══ FULL HITS ═══');
    for (const h of hits.slice(0, 20)) {
      console.log(`\n  ${h.description}`);
      console.log(`    new params:  ${h.newParams.join(',')}`);
      console.log(`    capHash:     ${h.capHash} ✓`);
      console.log(`    brandHash:   ${h.brandHash} ✓`);
    }
    if (hits.length > 20) console.log(`\n  ... and ${hits.length - 20} more`);
  }

  if (partialHits.length > 0) {
    console.log('\n═══ PARTIAL HITS (first 10) ═══');
    for (const h of partialHits.slice(0, 10)) {
      const which = h.capInWhitelist ? 'cap✓ brand✗' : 'cap✗ brand✓';
      console.log(`  ${which} | ${h.description} | capHash=${h.capHash} brandHash=${h.brandHash}`);
    }
  }

  if (hits.length === 0) {
    console.log('\n⚠️  No full hits found via single-change permutation.');
    console.log('\n   Whitelist sparsity analysis:');
    const capDensity = CAPABILITIES_INT32.length / 2 ** 32;
    const brandDensity = BRAND_CAPABILITIES_HEX.length / 2 ** 32;
    console.log(
      `     cap whitelist:   ${CAPABILITIES_INT32.length} / 2^32 = ${capDensity.toExponential(2)}`,
    );
    console.log(
      `     brand whitelist: ${BRAND_CAPABILITIES_HEX.length} / 2^32 = ${brandDensity.toExponential(2)}`,
    );
    console.log(
      `     joint density:   ${(capDensity * brandDensity).toExponential(2)} (independent assumption)`,
    );
    console.log(`     expected joint hit: 1 / ${(1 / (capDensity * brandDensity)).toExponential(2)} tries`);
    console.log('\n   Brute-force reverse-fit is mathematically infeasible:');
    console.log('   - Need ~2.7×10^14 tries for E[1 joint hit] — billions of times beyond reach');
    console.log('   - Whitelist is curated from real-user submissions, not algorithmically derived');
    console.log('\n   Practical paths forward:');
    console.log('   1. Real UHD 630 / UHD 620 user runs diagnose-creepjs-webgl-hash.ts');
    console.log('      and donates their authentic webglParams (if their hash is in whitelist)');
    console.log("   2. Accept: CreepJS bold-fail is a data-coverage limitation, not a spoof flaw.");
    console.log('      Real users with non-whitelisted GPUs face the same outcome.');
  }
}

main();
