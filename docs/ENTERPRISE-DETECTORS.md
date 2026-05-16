# Enterprise Detectors Landscape — Mosaiq 当前对策与 chromium-fork 候选

> 起草日期：2026-05-16（v0.4 Phase 4.4）
> 目的：identify 当前 SDK 注入路径无法 spoof 的 surface，为 chromium-fork
> 解冻（v1.0 上云 build）路径写 patch spec 设计稿。
> **chromium-fork 仍处冷藏**（见 `chromium-fork/STATUS.md`），本文档只交付 spec，
> 不实施 native build。

## 0. TL;DR

| Detector | 主要技术 | Mosaiq 注入对策 | chromium-fork 候选 |
|---|---|---|---|
| **Castle.io** (fingerprint-scan.com 后端) | 商业黑盒 ML | Phase 3.3 demote（不强 reverse） | 0016 headless detection bypass |
| **Imperva** (fp.com / ABP) | 多层指纹 + IP 信誉 | Phase 1-3 覆盖 SDK 层 | 0017 audio noise + 0011 JA4 |
| **DataDome** | 行为分析 + Canvas/WebGL | Phase 1.9 WebGL + 2.4 Canvas | 0001 canvas（已 spec）+ 0002 webgl-renderer |
| **Cloudflare BM** | JS 挑战 + TLS 指纹 | UA-CH + persona ipify | 0011 JA4（已 spec）+ 0012 H2 帧序 |
| **PerimeterX** (HUMAN) | Sensor data + 鼠标轨迹 | Humanize 引擎 v0.2 | 0014 persona bridge 已 spec（基础） |
| **Akamai BM** | 设备 ID + JA3/JA4 | UA-CH + proxy 配置 | 0011 JA4 + 0013 cookie partition |

**核心结论**：v0.3 - v0.4 SDK 路径已覆盖大部分免费 detector（sannysoft / arh-antoinevastel /
incolumitas / dbi-bot / browserleaks / CreepJS 主体）。**enterprise tier**
（Castle / Imperva / DataDome / Cloudflare / PerimeterX / Akamai）剩余 surface
需要在 chromium-fork patch 层解，主要是：

1. **GPU 进程层 vendor/renderer 字符串伪造**（绕过 Function.prototype.toString reverse）
2. **TLS/JA4 fingerprint**（BoringSSL ClientHello 顺序 + GREASE）
3. **HTTP/2 帧序**（Chromium net stack 强 mock）
4. **Audio fingerprint native noise**（Blink AudioBuffer C++ 层加 noise，绕过 JS Proxy 检测）
5. **Headless 显式标识**（CDP method `Page.IsAutomatedTask`、`--enable-automation` flag 暴露面）

---

## 1. Detector by Detector

### 1.1 Castle.io（fingerprint-scan.com 商业 demo）

**业务**：欺诈防控 SaaS（注册保护、账号接管检测、广告防作弊）

**技术拆解**：
- 加载 `cloudfront.net/v3/castle.browser.js`（前端指纹采集）+ `cstl.js`（后端打分）
- 服务端 0-100 risk score + binary verdict (`bot` / `not bot`)
- 算法 **黑盒 + ML 持续更新**，不可 reverse engineering
- 指标维度：~135 attrs（fingerprint-scan.com 暴露的 raw JSON 显示）

**Mosaiq 当前状态**：
- Phase 3.3 已 demote `score≥50 || verdict='bot'` 为 ℹ️ note（不入 bench hits）
- 主要 fingerprint 维度（UA / WebGL / Canvas / TLS）已 SDK 注入层覆盖
- 但 Castle ML 用大量 micro-features 组合（mouse cadence / touch event sub-pixel / WebRTC ICE candidate timing 等），单维度 spoof 通过仍可能综合判 bot

**chromium-fork 优先级**：**P3**（不直接对策，但 0014/0016 间接降分）
- ROI 低：Castle 是 enterprise tier，主流站不使用
- 真要 deal with：建议绕开（用 residential proxy + slow rotation），不强 spoof

---

### 1.2 Imperva（fp.com / Advanced Bot Protection）

**业务**：fp.com 是 Imperva 反爬产品的 **research demo**。Imperva ABP 是企业级（Cloudflare / Akamai 的对手）。

**技术拆解**：
- fp.com 暴露 ~50 fingerprint attrs（UA / screen / WebGL / Canvas / fonts / WebRTC / etc.）
- 服务端 risk score（unique fingerprint count + IP 信誉 + 行为模式）
- 关键 surface：
  - **WebRTC ICE candidate** 暴露真 LAN IP（即使 STUN 走 proxy）
  - **TLS ClientHello GREASE pattern + extension 顺序**（Imperva 用 JA3/JA4 fingerprint）
  - **Canvas font rendering 微像素差异**（同 font fallback chain 在不同 OS 下 render 略不同）
  - **Audio output latency**（AudioContext.baseLatency 跨硬件不同）

**Mosaiq 当前状态**：
- ✅ UA / WebGL / Canvas / Fonts / Audio AnalyserNode / Audio Buffer (Phase 4.1+4.2) 覆盖
- ✅ Phase 2.4 canvas 双 guard 修复 CreepJS lies（同源问题在 fp.com）
- ⚠️ WebRTC mode 仅 'disabled' / 'proxy_only' / 'default'，不强行 spoof ICE
- ⚠️ TLS ClientHello 在 BoringSSL 层固定（chromium 默认 GREASE 顺序 deterministic），SDK 注入修不到
- ⚠️ Audio output latency = config.audioOutputLatency，但 AudioContext.baseLatency 是 IDL 真实 getter（可能被绕开 spoof）

**chromium-fork 优先级**：**P1**（v1.0 解冻最优先）
- 候选 patch: `0011-tls-ja4-spoof` (已 spec) + `0017-audio-fingerprint-noise` (本 phase 新 spec)

---

### 1.3 DataDome

**业务**：欧美主流 anti-bot SaaS（米其林、Vinted、Le Bon Coin 等使用）

**技术拆解**：
- 客户端 challenge JS（混淆 + 自更新）+ 服务端 ML
- 关键 surface：
  - **fp-collect**（DataDome 研究员 Antoine Vastel 开源工具，仍在 production 用）
  - **Mouse movement** sensor + velocity / acceleration
  - **Canvas / WebGL fingerprint hash**
  - **WebDriver / CDP detection**（多种 JS 反检测探针）
- arh.antoinevastel.com/bots = fp-scanner 公开 demo（DataDome 反推工具）

**Mosaiq 当前状态**：
- ✅ Phase 3.1 Error.stack frame poisoning 应对 fp-collect `webDriver` advanced detection
- ✅ Phase 2.5/2.6 全面覆盖 arh-antoinevastel + incolumitas bench
- ✅ Phase 1.6 / 3.1 CDP detection hardening (Object.defineProperty stack 拦截)
- ✅ Humanize v0.2 mouse trajectory 三阶贝塞尔 + ease-in-out
- ⚠️ DataDome challenge JS 是混淆的，定期更新（可能引入新探针）

**chromium-fork 优先级**：**P2**
- 候选 patch: `0001-canvas-noise` (已 spec) + `0002-webgl-renderer-spoof` (本 phase 新 spec)

---

### 1.4 Cloudflare Bot Management

**业务**：托管平台默认开启（任意 Cloudflare 用户付费即用）

**技术拆解**：
- JS 挑战（Cloudflare Turnstile / cf_chl_jschl_tk）
- **TLS JA3/JA4 fingerprint**（强匹配 modern Chrome ClientHello）
- **HTTP/2 帧序**（SETTINGS / WINDOW_UPDATE / HEADERS 顺序 + 帧 priority）
- **Header order** 检测（Chrome 发 sec-* headers 顺序固定）
- 行为 sensor（page load timing, click cadence）

**Mosaiq 当前状态**：
- ✅ Header order：Playwright + UA-CH spoof 配合，sec-fetch-* 顺序近 Chrome 真实
- ⚠️ TLS JA3/JA4：Playwright 用 BoringSSL，**ClientHello 与真 Chrome 略不同**（extension 顺序 + GREASE 注入点），Cloudflare CDN 能识别
- ⚠️ HTTP/2 帧序：同样在 Chromium net stack 层固定，SDK 注入完全修不到

**chromium-fork 优先级**：**P0**（与 v1.0 商业化深度绑定）
- 候选 patch: `0011-tls-ja4-spoof` (已 spec) + `0012-h2-frame-order` (defer v1.5)

---

### 1.5 PerimeterX (HUMAN Security)

**业务**：合并入 HUMAN Security，主打 ad fraud 防控 + account takeover

**技术拆解**：
- **Sensor data** 持续采集（mouse / touch / scroll / accelerometer 移动设备）
- 鼠标轨迹**贝塞尔曲线** vs **直线** + 速度分布检测
- Canvas + WebGL fingerprint
- 设备 ID 持久化（多 session 关联）

**Mosaiq 当前状态**：
- ✅ Humanize v0.2 鼠标 / 键盘真人化（三阶贝塞尔 + dwell normal(70,20) + flight lognormal）
- ✅ Canvas / WebGL 覆盖
- ⚠️ Touch / accelerometer 没有 spoof（桌面 persona 不需要）
- ⚠️ 设备 ID 持久化：persona pool 解决，但 SDK 当前 single-persona

**chromium-fork 优先级**：**P3**
- 当前 SDK 路径已较好，不优先 fork

---

### 1.6 Akamai Bot Manager

**业务**：CDN + 反爬一体（Linux Foundation / 大型电商）

**技术拆解**：
- TLS JA3 + HTTP/2 fingerprint（与 Cloudflare 类似但算法独立）
- **Cookie 信任分层**：`_abck` cookie 跨 session 持久化，被识破 = 永久封 IP
- 设备 ID + IP 信誉

**Mosaiq 当前状态**：
- 与 Cloudflare 同类 surface（TLS / HTTP/2）
- Cookie 分区在 Playwright BrowserContext 层默认隔离，但 `_abck` 需要持久化保存以维持 trust

**chromium-fork 优先级**：**P0 = Cloudflare 同档**
- 候选 patch: `0011-tls-ja4-spoof` + `0013-cookie-jar-partition` (defer v1.5)

---

## 2. 候选 chromium-fork patch 总览

### 2.1 已有 spec（Phase A 三个）

| Patch | Spec 文件 | 状态 | v1.0 优先级 |
|---|---|---|---|
| `0001 Canvas Noise` | `chromium-fork/patches/0001-canvas-noise.spec.md` | 设计稿，未实施 | P1（SDK 已覆盖，patch 提供 native fallback） |
| `0011 TLS JA4 Spoof` | `chromium-fork/patches/0011-tls-ja4-spoof.spec.md` | 设计稿，未实施 | **P0** (商业关键) |
| `0014 Persona Bridge` | `chromium-fork/patches/0014-persona-bridge.spec.md` | 设计稿，未实施 | **P0**（所有其他 patch 基础设施） |

### 2.2 Phase 4.4 新增 spec

| Patch | Spec 文件 | 触发 enterprise detector | 优先级 |
|---|---|---|---|
| `0002 WebGL Renderer Spoof` | (本 phase 新建) | DataDome / CreepJS 49-param | P2 |
| `0016 Headless Detection Bypass` | (本 phase 新建) | Castle / DataDome (CDP method 暴露) | P2 |
| `0017 Audio Fingerprint Noise` | (本 phase 新建) | Imperva / DataDome (audio context fingerprint) | P3 |

### 2.3 后续 spec（v1.5+ defer）

| Patch | 业务依据 |
|---|---|
| `0012 H2 Frame Order` | Cloudflare / Akamai TLS+H2 双指纹 |
| `0013 Cookie Jar Partition` | Akamai `_abck` 跨 site 信任迁移 |
| `0015 WebUI Mosaiq` | persona 管理 UI（终端用户友好） |

---

## 3. 解冻路径

### 3.1 现状（v0.4 末）

- chromium-fork **冷藏中**（hardware 硬约束：i7-6500U + 11GB RAM 无法本地 build）
- 主线 SDK 注入路径已 cover 大部分免费 detector（v0.3 12-站 bench 12/12 OK 仅 2 known-limit）
- v0.4 在 SDK 层补 audio + alt GPU profile + chromium-fork docs

### 3.2 解冻触发条件（不变 STATUS.md §3.1）

1. ✅ Phase 1-2-3-4 实测出 ≥ 3 项指纹**只能 fork chromium 才能修**
2. ✅ Mosaiq 月收入 / 融资 ≥ €500
3. ✅ 客户群里有支付意愿明确升级到带 fork 版本

**预计 6-12 个月内触发**（v1.0 时间窗）。

### 3.3 v1.0 解冻路径（不重走 Phase A 半年路）

1. **云 build**：Hetzner CCX33（16vCPU/64GB）或 GitHub Actions self-hosted runner
2. **rsync 现有 27GB sync 数据** 到云 VM（省 4-8h fetch）
3. **Phase A.2 实施** `0014 persona-bridge`（必先做，所有其他 patch 依赖）
4. **Phase A.4 实施** `0011 tls-ja4-spoof`（最高商业价值）
5. **可选**：根据当时市场反馈选 `0001 canvas` / `0002 webgl` / `0016 headless` 中 1-2 个
6. 云端 build → `mosaiq-chrome` binary → 替换 playwright-core 默认 chromium

**预计 v1.0 工期：1-2 月**（不是半年），因为只做必要 patch + 云高配 build。

---

## 4. v0.4 交付物对照

| 交付 | 文件 | 状态 |
|---|---|---|
| 调研文档 | `docs/ENTERPRISE-DETECTORS.md` | 本文件 |
| Patch 0002 spec | `chromium-fork/patches/0002-webgl-renderer-spoof.spec.md` | Phase 4.4b 待写 |
| Patch 0016 spec | `chromium-fork/patches/0016-headless-detection-bypass.spec.md` | Phase 4.4b 待写 |
| Patch 0017 spec | `chromium-fork/patches/0017-audio-fingerprint-noise.spec.md` | Phase 4.4b 待写 |
| series.txt 更新 | `chromium-fork/patches/series.txt` | Phase 4.4b 加注释行 |

---

## 5. 参考

- `chromium-fork/STATUS.md` — 冷藏决策与解冻条件
- `docs/CHROMIUM-FORK-GUIDE.md` — 完整 460+ 行 fork 路线（Phase A.0-A.4）
- `chromium-fork/patches/0011-tls-ja4-spoof.spec.md` — 已有 TLS JA4 设计
- `packages/sdk/bench/PHASE-4-PLAN.md` — v0.4 路线图（含本 Phase 4.4 触发依据）
