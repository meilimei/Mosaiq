/**
 * creepjs-whitelist-data.ts — CreepJS WebGL whitelist 数据 + hash 算法
 *
 * 抽出供 `find-creepjs-whitelist-fit.ts`（Phase 2.2 reverse-fit 工具）
 * 与 `verify-creepjs-profile-hash.ts`（Phase 4.3 验证工具）共享。
 *
 * 数据源：creepjs/src/webgl/index.ts master + creepjs/src/utils/crypto.ts master
 * 复制时间：2026-05-16（v0.3 Phase 2.2）
 *
 * CreepJS LowerEntropy.WEBGL 触发条件：
 *   - capabilitiesHash (Int32 XOR reduce) ∉ CAPABILITIES_INT32 (~254 项)
 *   - brandCapabilities (hashMini 8-char hex) ∉ BRAND_CAPABILITIES_HEX (~270 项)
 *   两条都命中 = bold-fail 消失。一条 miss = LowerEntropy.WEBGL = true。
 *
 * 数学结论（Phase 2.2 Part 2）：blind brute-force expected joint hit = 2.7×10¹⁴ tries
 * → 数学不可行。新 profile 命中需要真机 capture pipeline。
 */

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITIES_INT32 — capabilitiesHash 白名单（int32，~254 项）
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITIES_INT32: readonly number[] = [
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

// ─────────────────────────────────────────────────────────────────────────────
// BRAND_CAPABILITIES_HEX — brandCapabilities 白名单（8-char hex，~270 项）
// ─────────────────────────────────────────────────────────────────────────────

export const BRAND_CAPABILITIES_HEX: readonly string[] = [
  '00b72507',
  '00c1b42d',
  '00fe1ec9',
  '02b3eea3',
  '0461d3de',
  '0463627d',
  '057857ac',
  '0586e20b',
  '0639a81a',
  '087d5759',
  '08847ba5',
  '0b2d4333',
  '0cdb985d',
  '0e058699',
  '0eb2fc19',
  '0f39d057',
  '0f840379',
  '0fc123c7',
  '101e0582',
  '12e92e62',
  '12f8ac14',
  '1453d59a',
  '149a1efa',
  '166dc7c8',
  '16c481a6',
  '171831c5',
  '177cc258',
  '18579e83',
  '19594666',
  '1b251fd7',
  '1bfd326c',
  '1e8a9a79',
  '1ff7c7e7',
  '2048bc5a',
  '2259b706',
  '22d0f2cf',
  '230d6a0d',
  '23d1ce20',
  '2402c3d2',
  '24306836',
  '258789d0',
  '25a760b8',
  '25f9385d',
  '27938830',
  '27db292c',
  '2b80fd96',
  '2bb488da',
  '2c04c2eb',
  '2d15287f',
  '2f014c41',
  '2f582ed9',
  '300ee927',
  '33bc5492',
  '34270469',
  '3660b71f',
  '3740c4c7',
  '3999a5e1',
  '39ead506',
  '3a91d0d6',
  '3b724916',
  '3bf321b8',
  '3c546144',
  '3f9ef44c',
  '3fea1100',
  '3ff82303',
  '4027d193',
  '402e1064',
  '4065cd69',
  '43038e3d',
  '4503e771',
  '461f97e1',
  '464d51ac',
  '467b99a5',
  '482c81b2',
  '48af038f',
  '4962ada1',
  '49bf7358',
  '4c9e8f5d',
  '502c402c',
  '508d1625',
  '52e348ba',
  '534002ab',
  '5582debe',
  '55d3aa56',
  '55e821f7',
  '581f3282',
  '5831d5fd',
  '58871380',
  '58fdc720',
  '5a5658f1',
  '5a90a5f8',
  '5aea1af1',
  '5b6a17aa',
  '5bef9a39',
  '5ca55292',
  '5d786cef',
  '5ddb9237',
  '5ee41456',
  '61178f2a',
  '61ca8e23',
  '61d9464e',
  '61eecaae',
  '623c3bfd',
  '6248d9e3',
  '6294d84e',
  '62bf7ef1',
  '6346cf49',
  '6357365c',
  '66628310',
  '668f0f93',
  '66d992e8',
  '67995996',
  '6843ebbf',
  '6864dcb0',
  '6951838b',
  '696e1548',
  '698c5c2e',
  '6a75ae3b',
  '6aa1ff7e',
  '6b07d4f8',
  '6b290cd4',
  '6c168801',
  '6dfae3cb',
  '6e806ffc',
  '6edf1720',
  '6f81cbe7',
  '70859bdb',
  '70a095b1',
  '7238c5dd',
  '7360ebd1',
  '741688e4',
  '74daf866',
  '78640859',
  '79284c47',
  '794f8929',
  '795e5c95',
  '79a57aa9',
  '7aa13573',
  '7b2e5242',
  '7b811cdd',
  '7ec0ea6b',
  '801d73af',
  '802e2547',
  '81b9cd29',
  '8219e1a4',
  '82a9a2f1',
  '8428fc8e',
  '849ccb64',
  '8541aa4c',
  '85479b99',
  '8bd0b91b',
  '8d371161',
  '903c8847',
  '917871e7',
  '98aeaba9',
  '99b1a1c6',
  '99ef2c3b',
  '9b67b7dc',
  '9c6df98c',
  '9c814c1b',
  '9e2b5e94',
  '9fd76352',
  'a1c808d5',
  'a22788f8',
  'a2383001',
  'a26e9aa9',
  'a397a568',
  'a3f9ee34',
  'a4b988da',
  'a4d34176',
  'a581f55e',
  'a5a477ae',
  'a9640880',
  'a97d3858',
  'aa73f3a4',
  'ab40bece',
  'ac4d4ba8',
  'ad01a422',
  'ade75c4f',
  'ae2c4777',
  'afa583bc',
  'b10c2a85',
  'b224cc7c',
  'b2d6fc98',
  'b362c2f5',
  'b467620a',
  'b4d40dcc',
  'b504662d',
  'b50edd99',
  'b5494027',
  'b62321c3',
  'b8961d15',
  'b8ea6e7f',
  'bb77a469',
  'bc0f9686',
  'bcf7315f',
  'be2dfaea',
  'beffda26',
  'bf06317e',
  'bf610cdb',
  'bfe1c212',
  'c00582e9',
  'c026469d',
  'c04889b1',
  'c04b0635',
  'c04e374a',
  'c05f7596',
  'c07307c6',
  'c092fdf8',
  'c25dd065',
  'c2bce496',
  'c5e9a883',
  'c79634c2',
  'c7e37ca0',
  'c93b5366',
  'c9bc4ffd',
  'cba1878b',
  'cbeade8c',
  'ce2e3d16',
  'cefb72ca',
  'cf9643e6',
  'cfd20274',
  'd05a66eb',
  'd09c1c07',
  'd1e76c89',
  'd2172943',
  'd2dc2474',
  'd498797d',
  'd6bf35ad',
  'd734ea08',
  'd860ff42',
  'd8bd9e5a',
  'd913dafa',
  'd970d345',
  'dbdbe7a4',
  'dc271c35',
  'dcd9a29e',
  'dd67b076',
  'de793ead',
  'ded74044',
  'df9daeb6',
  'e10339b3',
  'e142d1f9',
  'e155c47e',
  'e15afab0',
  'e16bb1bb',
  'e316e4c0',
  'e3eff92a',
  'e4569a5b',
  'e574bef6',
  'e5962ba3',
  'e6464c9f',
  'e68b5c4e',
  'e796b84e',
  'e8694547',
  'e965d180',
  'e965d541',
  'e9bdc904',
  'e9dbb8d5',
  'ea54d525',
  'ea59b343',
  'ea7f90ea',
  'ea8f5ad0',
  'eaa13804',
  'eb799d34',
  'ec050bb6',
  'ec928655',
  'eed2e5e1',
  'ef8f5db1',
  'f0d5a3c7',
  'f1077334',
  'f221fef5',
  'f2293447',
  'f33d918e',
  'f3c6ea11',
  'f51056a1',
  'f51cab9a',
  'f573bb34',
  'f5d19934',
  'f7451c92',
  'f8e65486',
  'f9714b3d',
  'fa994f33',
  'fafa14c0',
  'fc37fe1f',
  'fca66520',
  'fe0997b6',
];

export const CAPABILITIES_SET = new Set(CAPABILITIES_INT32);
export const BRAND_SET = new Set(BRAND_CAPABILITIES_HEX);

// ─────────────────────────────────────────────────────────────────────────────
// CreepJS hash algorithms (literal copy from creepjs/src/utils/crypto.ts master)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * hashMini — FNV-prime-style hash with djb2-31 multiplication; produces 8-char hex.
 * Source: creepjs/src/utils/crypto.ts master.
 */
export function hashMini(x: unknown): string {
  const json = `${JSON.stringify(x)}`;
  const hash = json.split('').reduce((h, _char, i) => {
    return (Math.imul(31, h) + json.charCodeAt(i)) | 0;
  }, 0x811c9dc5);
  return ('0000000' + (hash >>> 0).toString(16)).substr(-8);
}

/** capabilitiesHash = sortedUniqueParams.reduce((acc, v, i) => acc ^ ((v + i) | 0), 0) */
export function capabilitiesHash(sortedUniqueParams: readonly number[]): number {
  return sortedUniqueParams.reduce((acc, v, i) => acc ^ ((v + i) | 0), 0);
}

/**
 * 计算 brandCapabilities hash —— CreepJS 用 `hashMini([gpuBrand, '' + sortedParams])`。
 * gpuBrand 来自 `getGpuBrand(unmaskedRenderer)`：返回 'Intel' / 'NVIDIA' / 'AMD' / 'Apple' /
 * 'Google' / 其他。我们的 spoof 是 ANGLE wrap，brand 字符串通常被 CreepJS 抓到 vendor 部分。
 */
export function brandHash(gpuBrand: string, sortedUniqueParams: readonly number[]): string {
  return hashMini([gpuBrand, '' + sortedUniqueParams]);
}

// ─────────────────────────────────────────────────────────────────────────────
// CreepJS webglParams 抽取算法（mirror of creepjs/src/webgl/index.ts master）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * webglParams = Object.values(parameters).filter(v => v && typeof v != 'string')
 *               .flat().map(Number) → new Set(...) → sort((a, b) => a - b)
 *
 * `val && ...` filter 移除 0 / false / null / undefined / ''。
 * `typeof v != 'string'` 移除 VENDOR / RENDERER / VERSION 等 string param。
 * `.flat()` 把 typed-array dims（[16384, 16384]）展平。
 * `.map(Number)` 把 typed-array 元素转 number（普通 number 不变）。
 * Set + sort 去重排序。
 *
 * 注：原始算法 `Object.values()` 顺序无关（spec 上 own enumerable string keys 插入顺序，
 * 但 hash 用的是 sorted unique values，所以 input key 顺序不影响 output）。
 */
export function extractCreepjsWebglParams(
  webgl1Map: ReadonlyMap<number, number | readonly number[] | string>,
  webgl2Map: ReadonlyMap<number, number | readonly number[] | string>,
): readonly number[] {
  const all: number[] = [];
  // 合并 webgl1 + webgl2（GL2 inherits + overrides；本工具不区分，因 CreepJS
  // 把两个 context 的 parameters 合在一起 hash）
  const merged = new Map<number, number | readonly number[] | string>(webgl1Map);
  for (const [k, v] of webgl2Map) merged.set(k, v);

  for (const v of merged.values()) {
    // CreepJS: filter v=falsy 或 v=string
    if (!v || typeof v === 'string') continue;
    if (Array.isArray(v)) {
      for (const n of v) {
        if (n) all.push(Number(n));
      }
    } else if (typeof v === 'number' && v) {
      all.push(v);
    }
  }
  const unique = [...new Set(all)].sort((a, b) => a - b);
  return unique;
}
