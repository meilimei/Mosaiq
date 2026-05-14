# Mosaiq SDK — Baseline Detection Bench

> Phase 1 量化工具：跑现有 SDK 注入栈在反指纹检测站上的通过率，定 Phase 1 surface 优先级。

## 用法

仓库根目录：

```bash
# 1. 跑检测（默认 headless，6 个站点，约 90-120 秒）
pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts

# 2. 生成 report.md（自动用最新 results）
pnpm --filter @mosaiq/sdk exec tsx bench/report.ts

# 或指定 results 目录
pnpm --filter @mosaiq/sdk exec tsx bench/report.ts bench/results/2026-05-13T13-30-00-000Z
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HEADED` | unset | `=1` 显示浏览器（默认 headless） |
| `ONLY` | unset | 只跑指定站点 id（逗号分隔），如 `ONLY=sannysoft,creepjs` |
| `SKIP` | unset | 跳过指定站点 id |
| `TIMEOUT_MS` | `60000` | 单站超时 |
| `RESULTS_DIR` | 自动 | 自定义输出目录 |

## 站点（6 个）

| id | url | 等待 | 重点 |
|---|---|---|---|
| `sannysoft` | bot.sannysoft.com | 3s | headless markers / webdriver |
| `browserleaks-js` | browserleaks.com/javascript | 4s | navigator API 完整性 |
| `browserleaks-canvas` | browserleaks.com/canvas | 5s | Canvas hash + uniqueness |
| `browserleaks-webgl` | browserleaks.com/webgl | 5s | WebGL vendor / unmasked GPU |
| `iphey` | iphey.com | 6s | 综合一致性检测 |
| `creepjs` | abrahamjuliot.github.io/creepjs | 12s | trust score / lies / blocked |

## 输出

每次跑生成 `bench/results/<timestamp>/`：

```
results/2026-05-13T.../
├── raw.json              # 所有站点的结构化结果
├── report.md             # 人类可读报告 + Phase 1 surface 优先级
├── sannysoft.png         # 截图
├── sannysoft.html        # 完整 HTML
├── creepjs.png
├── creepjs.html
└── ...
```

## 报告内容

- **每站详情**：通过率 / 失败项 / 截图链接
- **Surface 优先级表**：把所有失败项归因到 Canvas / WebGL / Audio / Font / WebRTC / WebDriver / Navigator / Screen / Permissions / Timezone / Plugins，按加权分（high×3 + medium×1.5 + low×1）排序
- **推荐动作**：每个 surface 一句话告诉你 Phase 1 该怎么补

## 前置条件

1. `pnpm install` 已跑过
2. `pnpm --filter @mosaiq/persona-schema build && pnpm --filter @mosaiq/sdk build` 至少跑过一次（templates 需要 dist）
3. **playwright chromium 已下载**：`pnpm --filter @mosaiq/sdk exec playwright install chromium`
4. 网络可访问 `creepjs` / `browserleaks.com` / `iphey.com` / `bot.sannysoft.com`（**不需要 VPN，他们都是 public**）

## 限制

- iphey / creepjs 的 DOM 结构可能升级，特异提取器（`sites.ts` 里）可能需要适配
- bot.sannysoft.com 用 `.passed`/`.failed` 类名 + 颜色 fallback，覆盖率 90%+
- CreepJS trust score 提取依赖 `.trust-score` 选择器，他们如果改 className 就要更新
- 所有提取错误都会进 `extracted.error`，不会让整体 fail

## CI 集成（Phase 1 完成后）

加 GitHub Actions step：

```yaml
- name: baseline detection
  run: |
    pnpm --filter @mosaiq/sdk exec playwright install chromium
    pnpm --filter @mosaiq/sdk exec tsx bench/baseline-detection.ts
    pnpm --filter @mosaiq/sdk exec tsx bench/report.ts
- uses: actions/upload-artifact@v4
  with:
    name: baseline-results
    path: packages/sdk/bench/results/**
```

每个 PR 自动跑一次，对比通过率回归。

## 设计决策

- **headless 默认**：CI 友好。CreepJS 在 headless 会扣分（headless detection），实际产品用户应该用 headed，所以 `HEADED=1` 跑出来的 trust score 才接近真实场景
- **临时 persona**：用 `win11-chrome-us` 模板创建 ephemeral persona（id `baseline-bench`），跑完自动 delete，不污染 `~/.mosaiq/personas/`
- **不做断言**：bench 不 fail CI（除非整体 crash）。报告里的 priority 才是工程决策依据
- **顺序跑非并行**：避免同一 chromium 进程多 page 互相影响 fingerprint
