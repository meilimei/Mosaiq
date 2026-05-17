# Mosaiq v0.6 Plan — CreepJS Audio `trap` 闭合

> Status: 起草中（Phase 6.1 实现进行中）
> v0.5.0 release: `bf2e266` (tag `v0.5.0`)
> 起点 bench: `bench/results/2026-05-17T04-44-25-195Z` (post-5.4c)

## 背景

v0.5.0 把 CreepJS 12-site 套件的 visible hits 收敛到 3：
1. 🔴 `creepjs WebGL bold-fail` — 已知 long-term limit（Intel UHD 730 不在 CreepJS whitelist）
2. 🔴 `browserleaks-canvas uniqueness 100%` — by-design per-persona unique
3. 🟡 `creepjs Audio lies (trap)` — **本期目标**

Phase 5.4c 让 lies hash 从 `b726173b → 17db53bb`（关闭了
`getChannelData ↔ copyFromChannel sample mismatch` 一条 cross-check），
但 yellow severity 没消，因为 CreepJS 还有第二条 `noiseFactor` cross-check。

## CreepJS 上游公式（已读 src/audio/index.ts 确认）

```js
// Module load 时一次性
const AUDIO_TRAP = Math.random()

// 每次 page load 调用
const getCopyFrom = (rand, buffer, copy) => {
  const start = getRandFromRange(275, length - 21)
  const mid = start + 10
  const end = start + 20

  buffer.getChannelData(0)[start] = rand   // ← 写 1
  buffer.getChannelData(0)[mid]   = rand   // ← 写 2
  buffer.getChannelData(0)[end]   = rand   // ← 写 3
  buffer.copyFromChannel(copy, 0)          // ← 把 underlying 复制到 copy

  const attack = [
    buffer.getChannelData(0)[start] === 0 ? Math.random() : 0,
    buffer.getChannelData(0)[mid]   === 0 ? Math.random() : 0,
    buffer.getChannelData(0)[end]   === 0 ? Math.random() : 0,
  ]
  return [...new Set([...buffer.getChannelData(0), ...copy, ...attack])]
    .filter(x => x !== 0)
  // Real Chrome 期望：underlying = [0, ..., 0, rand, 0..., rand, 0..., rand, 0...]
  //                  copy 同 underlying
  //                  attack = [0, 0, 0]（因为写都活下来了）
  //                  Set = {0, rand}, filter !== 0 → [rand]
}

const getCopyTo = (rand, buffer, copy) => {
  buffer.copyToChannel(copy.map(() => rand), 0)
  const frequency = buffer.getChannelData(0)[0]   // = rand
  const dataAttacked = [...buffer.getChannelData(0)]
    .map(x => x !== frequency || !x ? Math.random() : x)
  return dataAttacked.filter(x => x !== frequency)
  // Real Chrome 期望：underlying = [rand, rand, ..., rand]
  //                  dataAttacked 全 = rand
  //                  filter !== rand → []
}

const getNoiseFactor = () => {
  const result = [...new Set([
    ...getCopyFrom(AUDIO_TRAP, new AudioBuffer({length: 2000, sampleRate: 44100}), new Float32Array(2000)),
    ...getCopyTo(AUDIO_TRAP, new AudioBuffer({length: 2000, sampleRate: 44100}), new Float32Array(2000)),
  ])]
  // Real Chrome: result = [rand]，length === 1
  return +(
    result.length !== 1 &&
    result.reduce((acc, n) => acc += +n, 0)
  )
  // Real Chrome: +(false && _) = 0
}

const noise = (
  noiseFactor || [...new Set(bins.slice(0, 100))].reduce((acc, n) => acc += n, 0)
)
// Real Chrome: noiseFactor = 0; bins[0..100] 是 dynamicsCompressor 的 pre-attack
//              silence ramp（exact 0），Set = {0}, sum = 0 → noise = 0

if (noise) {
  lied = true
  documentLie('AudioBuffer', 'sample noise detected')
}
```

`trap` HTML 字段：`!noise ? AUDIO_TRAP : getDiffs(AUDIO_TRAP, noise)`。
所以 v0.5.4c 显示 `trap: 932.726…` 中带 bold-fail 数字 = noise 非零 →
是 noiseFactor 非零（getCopyFrom / getCopyTo 不一致）。

## 根因（v0.5.4c 的 noiseFactor ≠ 0）

当前 `runner.ts §6` 的 `applyAudioNoise(target, channel)` 每次调用时
`makePrng(seed XOR channel)` 都重新初始化 PRNG → 重新生成 noise 序列 →
对同一份数据每次 add 不同 noise。

CreepJS getCopyFrom 流程在 v0.5.4c 下：

```
buffer.getChannelData(0)[start] = rand
  → hook 1: applyAudioNoise(underlying, 0) 加 noise₁ 到 underlying
  → caller 写 underlying[start] = rand。但 caller 写之前 underlying[start] 已被 noise 写成
    `0 + noise₁[start]` (silent buffer 时仅 if (sample !== 0) skip)
  → 实际：silent sample skip 让 underlying[start] 保持 0；caller 写 rand 进 underlying[start]

buffer.getChannelData(0)[mid] = rand
  → hook: applyAudioNoise(underlying, 0) 加 noise₂ 到 underlying（同一 underlying！）
  → 这一次 underlying[start] = rand（非 0）→ noise₂[start] 被加上 → underlying[start] = rand + noise₂[start]
  → caller 写 underlying[mid] = rand

buffer.getChannelData(0)[end] = rand
  → hook: applyAudioNoise(underlying, 0) 加 noise₃ 到 underlying
  → underlying[start] = rand + noise₂[start] + noise₃[start]
  → underlying[mid] 类似 + noise₃[mid]
  → caller 写 underlying[end] = rand

buffer.copyFromChannel(copy, 0)
  → hook: native copy underlying → copy
  → hook: applyAudioNoise(copy, 0) 再加 noise₄ 到 copy

buffer.getChannelData(0)[start] === 0?
  → hook: applyAudioNoise(underlying, 0) 加 noise₅
  → underlying[start] = rand + noise₂ + noise₃ + noise₅[start]; ≠ 0 → attack[0] = 0
buffer.getChannelData(0)[mid] === 0? 类似 → attack[1] = 0
buffer.getChannelData(0)[end] === 0? 类似 → attack[2] = 0

result = [...new Set([...underlying_with_noise, ...copy_with_noise, attack])]
  .filter(x => x !== 0)
  → 一堆非零 noise 值 → result.length 远 > 1 → noiseFactor = sum ≠ 0 → noise ≠ 0 → lied
```

`getCopyTo` 也类似破坏。

## 修复设计：Path A — 幂等记忆化（per-(buffer, channel)）

### 核心契约变更

| 维度 | v0.5.4c | v0.6.1 |
|---|---|---|
| Noise 应用时机 | 每次 hook 调用都加一次 | 每个 (buffer, channel) 一次 |
| caller 写持久性 | 写后立即被下一次 noise 抹掉 | 写后保留（noise 已应用过，不再重加） |
| copyFromChannel 一致性 | dest 加新 noise，与 underlying 不等 | dest 直接是 underlying 副本，完全一致 |
| copyToChannel 行为 | 写完再不动；下次 get 加 noise | 写完标记 (buffer, channel) 已 synced，不再加 noise |

### 数据结构

```typescript
// 模块级 WeakMap，buffer GC 时自动清理 (no leak)
const noisedChannels = new WeakMap<AudioBuffer, Set<number>>()

function ensureNoised(
  buf: AudioBuffer,
  channel: number,
  underlying: Float32Array,
  seed: number,
  amplitude: number,
): void {
  let set = noisedChannels.get(buf)
  if (!set) { set = new Set(); noisedChannels.set(buf, set) }
  if (set.has(channel)) return  // 已 noised 或 已 synced via copyToChannel

  const prng = makePrng((seed ^ channel) >>> 0)
  for (let i = 0; i < underlying.length; i++) {
    const sample = underlying[i] ?? 0
    // PRNG 每样本前进一次（保 deterministic）；只对 non-zero 样本写回
    const n = (prng() - 0.5) * amplitude
    if (sample !== 0) underlying[i] = sample + n
  }
  set.add(channel)
}
```

### 三个 hook 的新行为

```typescript
// getChannelData
AudioBuffer.prototype.getChannelData = wrapStealth(orig, {
  apply(target, thisArg, args) {
    const underlying = Reflect.apply(target, thisArg, args) as Float32Array
    const channel = (args[0] ?? 0) | 0
    ensureNoised(thisArg, channel, underlying, seed, amplitude)
    return underlying
  },
})

// copyFromChannel
AudioBuffer.prototype.copyFromChannel = wrapStealth(orig, {
  apply(target, thisArg, args) {
    const channel = (args[1] ?? 0) | 0
    // 先确保 underlying 加过 noise（lazy），再 native copy
    const underlying = Reflect.apply(origGCD, thisArg, [channel]) as Float32Array
    ensureNoised(thisArg, channel, underlying, seed, amplitude)
    return Reflect.apply(target, thisArg, args)
  },
})

// copyToChannel
AudioBuffer.prototype.copyToChannel = wrapStealth(orig, {
  apply(target, thisArg, args) {
    const result = Reflect.apply(target, thisArg, args)
    const channel = (args[1] ?? 0) | 0
    // caller 的数据已写进 underlying；标记为 已 synced，禁止后续 ensureNoised
    let set = noisedChannels.get(thisArg)
    if (!set) { set = new Set(); noisedChannels.set(thisArg, set) }
    set.add(channel)
    return result
  },
})
```

### 验证：CreepJS getCopyFrom 流程在新设计下

```
new AudioBuffer({length: 2000}) → underlying 全 0
buffer.getChannelData(0)[start] = rand
  → hook: ensureNoised → underlying 全 0，skip-zero 规则下 noise 不写入 → underlying 仍全 0
  → set.add(0)
  → caller 写 underlying[start] = rand
buffer.getChannelData(0)[mid] = rand
  → hook: ensureNoised → set.has(0) → 直接 return
  → caller 写 underlying[mid] = rand
buffer.getChannelData(0)[end] = rand
  → 同上 → caller 写 underlying[end] = rand

buffer.copyFromChannel(copy, 0)
  → hook: ensureNoised → set.has(0) → no-op
  → native copy underlying → copy
  → copy 等于 underlying (含三个 rand 写)

buffer.getChannelData(0)[start] === 0
  → hook: no-op
  → underlying[start] = rand ≠ 0 → attack[0] = 0 ✓

result = [...new Set([...underlying, ...copy, ...[0,0,0]])].filter(!== 0)
       = [...new Set([0,0,...,rand,...,rand,...,rand,...,0,  0,0,...,rand,...,rand,...,rand,...,0,  0,0,0])]
         .filter(!== 0)
       = [rand]
       length = 1 ✓
```

`getCopyTo`：

```
new AudioBuffer({length: 2000}) → underlying 全 0
buffer.copyToChannel(Float32Array.fill(rand), 0)
  → hook: native 写 underlying = [rand, rand, ..., rand]
  → set.add(0) （标记 synced）

frequency = buffer.getChannelData(0)[0]
  → hook: set.has(0) → no-op
  → underlying[0] = rand → frequency = rand

dataAttacked = [...buffer.getChannelData(0)].map(x => x !== rand || !x ? Math.random() : x)
  → 全 = rand → 全保留 → dataAttacked = [rand, rand, ..., rand]

result = dataAttacked.filter(x => x !== rand) = [] ✓
```

合并：
```
[...new Set([rand, ...[]])].filter unique → [rand] (从 getCopyFrom)
length = 1
noiseFactor = +(false && _) = 0 ✓
```

`noise = 0 || sum(unique(bins[0..100]))`。bins 来自 OfflineAudioContext + DynamicsCompressor 渲染：
- bins[0..100] 是 attack ramp 之前的 silence (exact 0)
- ensureNoised 的 skip-zero 规则保住 silence
- Set = {0}, sum = 0 → noise = 0 → no lied ✓

## Worker IIFE 镜像

`runner.ts §11` 把 §6 整段以字符串形式塞进 WorkerGlobalScope。WeakMap +
Set 在 Worker 里都可用。需要把 `noisedChannels` 和 `_ensureNoised` 也字
符串化到 IIFE 体内（IIFE 闭包内顶层 `var` 即可保 worker-scope-wide
单例）。

## 测试

`runner-audio.test.ts` 新增（Phase 6.1）：

1. **idempotence**：同一 buffer 同一 channel 多次 `getChannelData()` 返回的内容 byte-equal
2. **caller-write-survives**：`getChannelData()[i] = X` 后再读 `getChannelData()[i] === X`
3. **copyFromChannel-mirrors-underlying**：`copyFromChannel(dest, ch)` 后 `dest` byte-equal `getChannelData(ch)`
4. **copyToChannel-overrides**：`copyToChannel(src, ch)` 后 `getChannelData(ch)` byte-equal `src`，无额外 noise
5. **CreepJS getNoiseFactor 复刻**：组装 getCopyFrom + getCopyTo 流程，断言 result Set size === 1，noiseFactor === 0
6. **silence preserved**：fresh `new AudioBuffer({length: 5000})` 经 hook 后 `getChannelData(0)` 仍全 0
7. **per-channel isolation**：channel 0 与 channel 1 分别 ensureNoised，互不影响
8. **PRNG-deterministic**：相同 seed 多次构造同一类 buffer，noise 序列字节相同

`runner-worker.test.ts` 新增 3 项静态字符串断言：
1. IIFE 含 `WeakMap` 实例化
2. IIFE 含 `_ensureNoised` 函数定义
3. IIFE 含 `set.has(ch)` early return 语义

## Bench 验收标准

新 bench run（post-6.1）期望：
- `creepjs.html` Audio surface 不再有 `lies` class（hash 处变为 plain hash）
- `report.md` 不再有 `creepjs lies: Audio` 项
- 总 visible hits 降到 **2**（仅剩 2 个 long-term known-limit reds）
- `trap` 字段显示 `AUDIO_TRAP` plain（无 bold-fail diff）

## 风险与回滚

- 风险 1：copyToChannel 标记 synced 后，若 caller 调 copyToChannel 写入新内容，那次的内容是 caller 给的（无 noise）。这对 fingerprint 防御无影响（caller 数据本身就是 caller 控的）；可接受。
- 风险 2：WeakMap 持有 AudioBuffer ref 是否阻止 GC？WeakMap 的 key reference 是 weak，不阻 GC ✓
- 回滚：单点改动 `runner.ts §6` + worker IIFE，可单 commit 完整恢复。

## Atomic commits 计划

1. **Phase 6.1**: `feat(sdk): per-(buffer, channel) noise memoization (CreepJS audio trap)`
   - runner.ts §6 重写
   - worker IIFE 镜像
   - 8 + 3 vitest cases
2. **chore(release): v0.6.0**
   - bump 3 package.json → 0.6.0
   - CHANGELOG v0.6.0 节
   - tag v0.6.0
   - push origin main --tags

## 不在 v0.6 范围

- CreepJS WebGL bold-fail：上游 whitelist gap，long-term。
- browserleaks-canvas 100% uniqueness：by-design。
- chromium-fork 实际 build：仍在 cold storage。
- launcher.ts / browser-session.ts 单测：技术债，下个版本。
