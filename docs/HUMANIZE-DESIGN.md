# Humanize 引擎设计 (v0.2)

> 状态：设计稿（v0.2 起步）
> 范围：纯软件层（不涉及 Chromium fork）。SDK 内部实现，对外暴露 `BrowserSession.humanize` 接口。
> 目标：让 Playwright 自动化的鼠标/键盘事件序列在统计特征上接近真实用户，避开「无人类输入特征」类风控扣分。

---

## 1. 背景：为什么单纯 Playwright 像机器人

Playwright 默认行为：

| 操作 | Playwright 默认 | 真人 |
|---|---|---|
| `page.click(sel)` | 元素中心瞬间 mousemove → 1 帧后 mousedown → mouseup（间隔 0–10ms） | 鼠标曲线移动 200–600ms，到达后 hover 30–200ms 才 mousedown，down→up 50–150ms |
| `page.fill(sel, text)` | 直接 input 事件，无 keyboard event | 每键 keydown→keyup，dwell 50–200ms，键间 flight 50–300ms |
| `page.keyboard.type(text)` | 等间隔 keydown/keyup（Playwright 有 `delay`，但默认 0） | dwell/flight 服从 lognormal 分布，存在 typo + backspace |
| `mousemove` 路径 | 单跳直线（甚至无中间事件） | cubic bezier + 抖动 + overshoot；事件密度 60–120 Hz |

**主流风控特征**：

- **Datadome / PerimeterX / Akamai BotManager** 收集 `mousemove` 序列做轨迹分类（直线 / 曲线 / 速度抖动 / 加速度 zero-cross 数）
- **Cloudflare Turnstile** 隐式收集页面停留期间的 input 事件密度，无任何 mouse/keyboard 直接判机器人
- **reCAPTCHA v3** score 模型大量依赖输入节律熵

**优先级**：v0.2 先解决 mouse trajectory + keyboard dwell，足以把绝大多数中低强度站点的 BotScore 拉到「人类」段位。Datadome 这种顶级供应商需要 v0.3+ 配合 TLS/JA3 + Chromium fork 才能压制。

---

## 2. API 设计

### 2.1 入口

```ts
class BrowserSession {
  readonly humanize: Humanize;
  // ...
}

class Humanize {
  constructor(page: Page, opts?: HumanizeDefaults);
  /** 移动鼠标到选择器中心（默认）或元素内随机点 */
  moveTo(target: string | { x: number; y: number }, opts?: MoveOptions): Promise<void>;
  /** 移动到目标 + 短 hover + mousedown/up */
  click(selector: string, opts?: ClickOptions): Promise<void>;
  /** focus selector 并按 plan 逐键输入 */
  type(selector: string, text: string, opts?: TypeOptions): Promise<void>;
}
```

### 2.2 选项

```ts
interface HumanizeDefaults {
  /** 影响 typing 速度 + mouse duration。默认 'normal' */
  speed?: 'slow' | 'normal' | 'fast';
  /** 用于可复现性。未传则每次随机；传了 → 同 seed 同输入产生同序列。 */
  seed?: string;
}

interface MoveOptions {
  /** 总移动时长 ms。默认按距离推算：80 + dist * 0.6 */
  durationMs?: number;
  /** 是否引入 overshoot（先冲过目标 5–15px 再回拉） */
  overshoot?: boolean; // 默认 true
  /** 事件采样频率 Hz。默认 60 */
  sampleHz?: number;
  /** 选择目标点策略：'center' / 'random'（在元素 bounding box 内均匀） */
  pointStrategy?: 'center' | 'random'; // 默认 'random'
}

interface ClickOptions extends MoveOptions {
  /** 鼠标到达目标后的 hover 停顿 ms。默认 [30, 180] 区间随机 */
  hoverMs?: number | [number, number];
  /** mousedown → mouseup 的 dwell ms。默认 [50, 130] 区间随机 */
  pressMs?: number | [number, number];
  /** 'left' / 'right' / 'middle'。默认 'left' */
  button?: 'left' | 'right' | 'middle';
}

interface TypeOptions {
  /** 平均 flight time ms。默认 110，会被 speed 选项缩放 */
  avgFlightMs?: number;
  /** 平均 dwell time ms。默认 70 */
  avgDwellMs?: number;
  /** typo 概率 0..1。启用后插入随机相邻键 + backspace 修正。默认 0 */
  typoRate?: number;
  /** 输入前先 click 选择器。默认 true */
  clickFirst?: boolean;
}
```

---

## 3. 鼠标轨迹算法

### 3.1 三阶贝塞尔（默认）

给定起点 `p0 = (x0, y0)` 终点 `p3 = (x1, y1)` 距离 `d = |p3 - p0|`，控制点：

```
midpoint m = (p0 + p3) / 2
perpendicular n = unit(p3 - p0).rot90()
jitter1 = rng.uniform(-1, 1) * d * 0.15
jitter2 = rng.uniform(-1, 1) * d * 0.15
c1 = m + n * jitter1
c2 = m + n * jitter2
```

贝塞尔曲线：

```
B(t) = (1-t)³·p0 + 3(1-t)²t·c1 + 3(1-t)t²·c2 + t³·p3,   t ∈ [0, 1]
```

时间映射 `t(τ)` 用 ease-in-out（cubic）让中间速度最高、两端慢：

```
ease(τ) = τ < 0.5 ? 4τ³ : 1 - (-2τ + 2)³ / 2,   τ ∈ [0, 1]
```

采样：N = `round(durationMs * sampleHz / 1000)`，对每个 `i ∈ [0, N]`，
- `τ = i / N`
- `t = ease(τ)`
- `(x, y) = B(t)`
- 时间戳 = `τ * durationMs`

### 3.2 Overshoot

当 `overshoot=true` 且 `d > 80px`：把终点暂时改成 `p3 + n_to_target * over_dist`（`over_dist = rng.uniform(8, 18)`），生成 70% 时长的轨迹到达过冲点；然后再 30% 时长走一段短贝塞尔从过冲点回到 `p3`。

### 3.3 失败模式 / 边界

- **同点移动**（`d < 1px`）：直接 emit 单个 point，跳过曲线
- **极小距离**（`d < 30px`）：禁用 overshoot，jitter 减半
- **极大距离**（`d > 1500px`）：拆成 2 段贝塞尔（避免控制点偏移过大产生不真实回环）

---

## 4. 键盘节律算法

### 4.1 dwell / flight 分布

- **dwell**（keydown→keyup）：normal(μ=70ms, σ=20ms)，clamp 到 [25, 250]
- **flight**（前一 keyup 到下一 keydown）：lognormal(μ=ln(110), σ=0.35)，clamp 到 [25, 1000]

研究依据：[KeyTrac / TypingDNA](https://www.typingdna.com/) 公开数据 — 真人 dwell 平均 80ms ± 25ms，flight 平均 130ms 但右偏。

### 4.2 节律调整

- **空格之后**：flight × 1.4（停顿表达 word boundary）
- **逗号/句号之后**：flight × 1.6
- **连续相同字母**（"oo"）：flight × 0.8（手指无需切换）
- **大写字母**：先按 Shift，dwell 长 +30ms，松开 Shift 在字母 keydown 后

### 4.3 Typo 模型（可选）

`typoRate > 0` 时，每键有 `typoRate` 概率插入：
1. 输入相邻键（QWERTY 布局静态映射）
2. 100–400ms flight
3. Backspace
4. 50–200ms flight
5. 输入正确键

**默认关闭**，因为部分网站（注册表单 / 验证码）会因为输入回退被怀疑（"为什么用户来回改？"）。仅在长文本（评论 / 帖子内容）场景开启。

### 4.4 Speed 缩放

| Speed | flight 系数 | dwell 系数 |
|---|---|---|
| slow | 1.5 | 1.2 |
| normal | 1.0 | 1.0 |
| fast | 0.65 | 0.85 |

---

## 5. 实现拆分

### 5.1 模块结构

```
packages/sdk/src/humanize/
├── rng.ts              # mulberry32 + gauss + lognormal，无外部依赖
├── mouse.ts            # planMouseTrajectory(from, to, opts, rng) -> Point[]
├── keyboard.ts         # planTypingPlan(text, opts, rng) -> KeyEvent[]
├── humanize.ts         # Humanize 类，组合上述纯函数 + Playwright IO
├── rng.test.ts
├── mouse.test.ts
├── keyboard.test.ts
└── index.ts            # 公共 export
```

### 5.2 关键纯函数签名

```ts
// rng.ts
export function makeRng(seed: string): Rng;
export interface Rng {
  uniform(min: number, max: number): number;
  gauss(mean: number, stddev: number): number;
  lognormal(meanLog: number, stddevLog: number): number;
  pick<T>(arr: readonly T[]): T;
}

// mouse.ts
export interface MousePoint { x: number; y: number; tMs: number; }
export interface PlanMouseInput {
  from: { x: number; y: number };
  to: { x: number; y: number };
  durationMs?: number;
  sampleHz?: number;
  overshoot?: boolean;
}
export function planMouseTrajectory(input: PlanMouseInput, rng: Rng): MousePoint[];

// keyboard.ts
export interface KeyEvent {
  key: string;       // Playwright Key 名称: 'a' / 'Shift' / 'Backspace'
  type: 'down' | 'up';
  tMs: number;       // 自此次 type() 开始的相对时间戳
}
export interface PlanTypingInput {
  text: string;
  avgFlightMs?: number;
  avgDwellMs?: number;
  typoRate?: number;
  speedScale?: { flight: number; dwell: number };
}
export function planTypingPlan(input: PlanTypingInput, rng: Rng): KeyEvent[];
```

### 5.3 IO 层（薄壳，不直接单测）

```ts
class Humanize {
  async moveTo(target, opts): Promise<void> {
    const to = await this.resolvePoint(target, opts);
    const from = await this.currentMousePos(); // page.evaluate 拿 last known
    const points = planMouseTrajectory({ from, to, ... }, this.rng);
    let prevT = 0;
    for (const p of points) {
      await sleep(p.tMs - prevT);
      await this.page.mouse.move(p.x, p.y);
      prevT = p.tMs;
    }
  }

  async type(selector, text, opts): Promise<void> {
    if (opts.clickFirst ?? true) await this.click(selector);
    const events = planTypingPlan({ text, ... }, this.rng);
    let prevT = 0;
    for (const ev of events) {
      await sleep(ev.tMs - prevT);
      if (ev.type === 'down') await this.page.keyboard.down(ev.key);
      else await this.page.keyboard.up(ev.key);
      prevT = ev.tMs;
    }
  }
}
```

---

## 6. 测试策略

### 6.1 单元测试（覆盖 v0.2 提交）

`rng.test.ts`：
- mulberry32 与同 seed 输出确定性序列
- gauss 大样本 (n=10000) μ ≈ mean，σ ≈ stddev (±5%)
- lognormal 全为正、median ≈ exp(meanLog)
- pick 在数组上均匀

`mouse.test.ts`：
- 起点 = `points[0]`，终点 = `points[N]`（最后一个）
- 时间戳单调递增，最后一个 = `durationMs`
- 没有 NaN / Infinity
- N ≈ `durationMs * sampleHz / 1000` (±1)
- 同 seed 两次调用结果完全一致
- 不同 seed 结果不同
- overshoot=true 时存在某个中间点超过终点（沿目标方向）
- 同点移动（d<1）→ 单点
- 大距离（d=2000）不爆（会拆段，仍然 monotonic）

`keyboard.test.ts`：
- 给定 "abc"，事件序列：[down a, up a, down b, up b, down c, up c]
- 时间戳单调递增
- 大写 "A"：[down Shift, down a, up a, up Shift]
- dwell ≈ avgDwellMs（统计 1000 次大文本，±20%）
- flight ≈ avgFlightMs（同上）
- typoRate=0.1 + 长文本，事件中存在 Backspace
- 同 seed 同 text → 同序列

### 6.2 集成测试（v0.2.x 后续）

- 跑真实 Chromium，访问 [bot.sannysoft.com](https://bot.sannysoft.com) 和 [arh.antoinevastel.com](https://arh.antoinevastel.com/bots/)，对比 humanize on/off 的 BotScore。
- 不进入 v0.2 首版（需要 CI 配 headed Chromium，先在 dev 机本地手测）。

---

## 7. 与现有 v0.1 的关系

- **零侵入**：v0.1 的 `BrowserSession.context` / `firstPage()` / `open()` / `close()` 完全保留，调用方不强制使用 humanize
- **lazy**：`session.humanize` 用 getter 懒加载，没用到不创建 RNG
- **seed 联动**：`humanize` 默认 RNG 从 `persona.fingerprint.canvas.noiseSeed` 派生，保证「同 persona = 同输入风格」，便于排查与复现

---

## 8. 已知限制（写进 README，不修）

1. **不替代验证码**：Cloudflare Turnstile / reCAPTCHA v3 仍可能 challenge，humanize 只降低基线分
2. **Linux 鼠标精度**：Linux Chromium 的 `page.mouse.move` 整数舍入更激进，轨迹可能略不平滑（本地测试无影响）
3. **WebDriver 标志位**：humanize 不修复 `navigator.webdriver`，由 v0.1 注入层处理
4. **不模拟 touch**：移动端 fingerprint 暂未支持，humanize 仅桌面 mouse + keyboard

---

## 9. 后续路线

- **v0.2.x**：humanize 集成测试 + 文档示例
- **v0.3**：minimum-jerk 轨迹（比 cubic bezier 更接近真人神经运动模型）
- **v0.4**：Pause modeling — 长文本输入中加入 thinking pause（500–3000ms 服从 Pareto），匹配真人写帖子的节律
