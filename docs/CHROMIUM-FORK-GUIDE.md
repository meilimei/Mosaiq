# Chromium Fork 技术指南

> **目标读者**：Mosaiq 内核工程师候选人 + 技术合伙人 + 架构评审者。
>
> 这份文档**回答一个问题**：从 0 开始 fork Chromium、注入反指纹 patch、稳定发布的技术路径是什么。

---

## 0. 速览

| 维度 | 决策 |
|---|---|
| **Chromium 版本基线** | 跟随 stable 通道（每 4 周一次发布） |
| **首期 patch 数** | 10 个（v0.1 MVP） |
| **构建系统** | `gn` + `ninja`（Chromium 标准） |
| **CI** | GitHub Actions self-hosted runner（自购 server）+ AWS spillover |
| **目标平台** | Win64 / macOS（Apple Silicon + Intel）/ Linux x64 |
| **首次完整编译时间** | 4–6 小时（128GB / 32 核） |
| **增量编译** | 5–30 分钟 |
| **Patch 管理工具** | `git-cl` + 自研 patch series 管理脚本 |
| **上游同步** | Auto-merge bot，stable 发布 7 天内合入 |

---

## 1. 编译环境搭建

### 1.1 硬件要求（推荐配置）

| 角色 | 最低 | 推荐 | 理想 |
|---|---|---|---|
| **CPU** | 8 核 | 32 核 | 64 核（AMD Threadripper / EPYC） |
| **RAM** | 16 GB | 64 GB | 128 GB |
| **磁盘** | 200 GB SSD | 500 GB NVMe | 1 TB NVMe |
| **网络** | 100 Mbps | 1 Gbps | 1 Gbps（首次 clone Chromium ~20GB） |

> 一台自购 AMD EPYC 7763（64 核 / 128GB / 2TB NVMe）约 ¥6–8 万，比 AWS c6i.16xlarge 跑 18 月（~¥12 万）便宜，且全天候可用。

### 1.2 操作系统

| 阶段 | 推荐 OS |
|---|---|
| **早期开发 / 跨平台测试** | Ubuntu 22.04 LTS（Chromium 官方文档最完善） |
| **Windows build** | Windows 11 Pro + Visual Studio 2022（Chromium 必须用 MSVC） |
| **macOS build** | macOS 14.x + Xcode 15.x（Apple Silicon 推荐 M2 Max+） |

> 不能在一台机上交叉编译三平台。**至少需要 3 台 build 机**（或 3 个 VM）。

### 1.3 安装 depot_tools

`depot_tools` 是 Chromium 的瑞士军刀（含 `gclient`、`gn`、`autoninja`、`git-cl` 等）。

**Linux / macOS**：

```bash
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
echo 'export PATH="$PATH:$HOME/depot_tools"' >> ~/.bashrc
source ~/.bashrc
```

**Windows**：

```powershell
# 1. 下载 https://storage.googleapis.com/chrome-infra/depot_tools.zip
# 2. 解压到 C:\depot_tools
# 3. 添加到 PATH（必须放最前面，覆盖系统 git）
# 4. 设置环境变量：
[Environment]::SetEnvironmentVariable("DEPOT_TOOLS_WIN_TOOLCHAIN", "0", "User")
```

### 1.4 拉取 Chromium 源码

```bash
mkdir ~/chromium && cd ~/chromium
fetch --nohooks chromium       # ~20 GB clone，1–2 小时
cd src
gclient sync --no-history      # ~30 GB 同步依赖
./build/install-build-deps.sh  # Linux 安装系统依赖
gclient runhooks               # 拉 hooks
```

### 1.5 切换到目标 stable 版本

```bash
# 假设当前 stable 是 134.0.6998.117
git checkout -b mosaiq-fork/134.0.6998.117 134.0.6998.117
gclient sync --with_branch_heads --with_tags
```

> Chromium tag 命名规则：`MAJOR.MINOR.BUILD.PATCH`，每月 +1。可在 [Chromium Dash](https://chromiumdash.appspot.com/branches) 查最新 stable。

### 1.6 首次完整 build

```bash
cd ~/chromium/src
gn gen out/Default --args='is_debug=false is_official_build=true symbol_level=1 enable_nacl=false'
autoninja -C out/Default chrome   # 4–6 小时
```

> `is_official_build=true` 启用 LTO + PGO，体积更小但编译慢 2 倍。开发阶段先用 `is_debug=false symbol_level=2 is_component_build=true`，编译快 5–10 倍。

---

## 2. Mosaiq fork 仓库结构

```
mosaiq-chromium/                          # 公开仓库（GPL-2.0）
├── README.md
├── DEPS                                   # 我们自定义的依赖（指向上游 Chromium 某 tag）
├── patches/
│   ├── series.txt                         # patch 应用顺序（quilt 风格）
│   ├── 0001-canvas-noise.patch
│   ├── 0002-webgl-renderer-spoof.patch
│   ├── 0003-audio-noise.patch
│   ├── 0004-navigator-id.patch
│   ├── 0005-client-hints.patch
│   ├── 0006-screen-spoof.patch
│   ├── 0007-hardware-spoof.patch
│   ├── 0008-timezone-spoof.patch
│   ├── 0009-fonts-metrics-noise.patch
│   ├── 0010-webrtc-policy.patch
│   ├── 0011-tls-ja3-spoof.patch         # v0.5 才上
│   ├── 0012-h2-frame-order.patch         # v0.5
│   ├── 0013-cookie-jar-partition.patch   # v0.5
│   ├── 0014-persona-bridge.patch         # v0.5（mojom 接口 Renderer↔Browser）
│   └── 0015-webui-mosaiq.patch           # v0.5（注册 chrome://mosaiq/* WebUI）
├── scripts/
│   ├── apply-patches.sh
│   ├── sync-upstream.sh                   # 自动从上游 Chromium 同步并 rebase patches
│   ├── build-all.sh                       # 三平台构建
│   └── package-mosaiq.sh                  # 打包 + 签名
├── src/chrome/browser/mosaiq/             # C++ Browser Process Services（独立 component）
│   ├── BUILD.gn
│   ├── persona_service.cc / .h               # PersonaService（继承 KeyedService，绑 BrowserContext）
│   ├── license_service.cc / .h               # LicenseService（移植自 Shieldly license.ts 逻辑）
│   ├── proxy_router.cc / .h                  # per-profile Proxy 路由
│   ├── detection_lab_runner.cc / .h
│   └── mojom/persona.mojom                   # mojom IPC 接口定义、供 Renderer/WebUI 调用
├── src/chrome/browser/resources/mosaiq/   # WebUI 面板（React + TS 源码）
│   ├── mosaiq_resources.grd                  # 资源描述文件，编译进二进制
│   ├── profile_manager/
│   ├── detection_lab/
│   └── settings/
├── src/chrome/browser/ui/views/mosaiq/    # 定制 native shell （品牌/profile switcher）
├── tests/
│   ├── detection-suite/                   # 自动跑 IPHey/CreepJS/BrowserScan 的测试
│   └── unit/
└── .github/workflows/
    ├── build-linux.yml
    ├── build-macos.yml
    ├── build-windows.yml
    └── upstream-sync.yml
```

---

## 3. 首期 10 个 Patch 详细定位

### Patch 0001: Canvas Noise

**目标**：在 `<canvas>` 的像素读取路径注入 per-persona 噪声，绕过 JS 层 hook 检测。

**触点文件**：

```
third_party/blink/renderer/core/html/canvas/html_canvas_element.cc
third_party/blink/renderer/core/html/canvas/canvas_rendering_context_2d.cc
third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d_api.cc
```

**实现要点**：

- 在 `HTMLCanvasElement::ToDataURL` / `ToBlob` 入口拦截
- 调用 `PersonaBridge::GetCanvasNoise()` 拿到 persona 绑定的噪声 PRNG
- 对 `ImageData` 像素做亚像素扰动（每像素 RGB 各 ±1，alpha 不变）
- 关键：**噪声 must be deterministic per persona**，否则同 persona 多次 hash 不一致也是检测信号

**测试**：
- 单元测试：相同 persona 同一 canvas 渲染产生相同 hash
- 跨 persona：hash 应不同
- BrowserScan / FingerprintJS Pro 检测应通过

### Patch 0002: WebGL Renderer / Vendor String Spoof

**触点文件**：

```
third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc
third_party/blink/renderer/modules/webgl/webgl2_rendering_context.cc
gpu/config/gpu_info.cc
```

**实现要点**：

- 拦截 `WebGLRenderingContextBase::getParameter(GL_RENDERER)` / `GL_VENDOR` / `GL_VERSION`
- 拦截 `getParameter(UNMASKED_RENDERER_WEBGL)` / `UNMASKED_VENDOR_WEBGL`
- 返回 persona 绑定的 GPU 字符串（如 "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)"）
- 同时改 `GL_EXTENSIONS` 列表保持与 GPU 型号一致

**陷阱**：
- WebGL2 有独立 context，必须双改
- ANGLE 层（DirectX 转译）也需考虑
- `WEBGL_debug_renderer_info` extension 是反检测重灾区

### Patch 0003: AudioContext Noise

**触点文件**：

```
third_party/blink/renderer/modules/webaudio/audio_buffer.cc
third_party/blink/renderer/modules/webaudio/offline_audio_context.cc
```

**实现要点**：
- 在 `AudioBuffer::getChannelData` 出口对样本数据加 per-persona PRNG 噪声
- 噪声振幅 < 1e-7（不影响听感但改变 fingerprint hash）

### Patch 0004: Navigator ID

**触点文件**：

```
third_party/blink/renderer/core/frame/navigator_id.cc
third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc
third_party/blink/renderer/core/frame/navigator_language.cc
```

**实现要点**：
- `userAgent` / `appVersion` / `platform` / `vendor` / `product` 全部 persona 绑定
- `hardwareConcurrency` / `deviceMemory` persona 绑定
- `language` / `languages` persona 绑定（与 Accept-Language 头联动）

### Patch 0005: Client Hints (UA-CH)

**触点文件**：

```
services/network/public/cpp/client_hints.cc
content/browser/client_hints/client_hints.cc
third_party/blink/renderer/core/frame/navigator_ua_data.cc
```

**实现要点**：
- 修改 `Sec-CH-UA` / `Sec-CH-UA-Platform` / `Sec-CH-UA-Mobile` 等所有发送头
- 修改 JS 端 `navigator.userAgentData.getHighEntropyValues()` 返回值
- **必须与 patch 0004 联动**，否则 UA 与 UA-CH 矛盾立即被检出

### Patch 0006-0009: Screen / Hardware / Timezone / Fonts

每个都是相对简单的 getter 拦截，参照上面模式。Fonts 略复杂：

**Fonts 的触点**：

```
third_party/blink/renderer/platform/fonts/font_cache.cc
third_party/blink/renderer/platform/fonts/font_global_context.cc
third_party/blink/renderer/modules/font_access/font_data.cc
```

**实现**：
- 限制 `document.fonts` 枚举到 persona 字体集
- `FontFace.load()` 只允许 persona 字体集中的字体真实加载，其他返回 `error`
- text metric 测量加 per-persona 微小噪声

### Patch 0010: WebRTC IP Policy

**触点文件**：

```
third_party/webrtc/p2p/base/port_allocator.cc
third_party/webrtc/p2p/base/basic_port_allocator.cc
chrome/browser/media/webrtc/webrtc_log_uploader.cc
```

**实现要点**：
- 强制 `default_public_interface_only` 策略
- 屏蔽 host candidate 中的私网地址
- 完全禁用 mDNS hostname 候选（`enumeration_policy = ENUMERATION_BLOCKED`）
- 对外只暴露 STUN reflexive address（即代理出口 IP）

### v0.5 才上的高级 patch（0011-0014）

**Patch 0011: TLS / JA3+JA4 Spoof**（最难也最值钱）

**触点文件**：

```
net/socket/ssl_client_socket_impl.cc
net/ssl/ssl_config.cc
third_party/boringssl/src/ssl/handshake_client.c
third_party/boringssl/src/ssl/extensions.cc
```

**实现要点**：
- 修改 `SSL_CTX_set_cipher_list` 顺序匹配 persona 目标 OS+Chrome 版本
- 修改 `SSL_extension_supported` 顺序与 GREASE 占位
- 修改 `signature_algorithms` 列表
- 修改 `supported_groups`（曲线列表）
- 自定义 ALPN protocols 顺序

**陷阱**：
- BoringSSL 是 Chromium 自有 fork，与 OpenSSL API 不一致
- TLS 库改动会影响 QUIC（HTTP/3），必须同步处理
- 测试需用 [tls.peet.ws](https://tls.peet.ws/) / [browserleaks.com/tls](https://browserleaks.com/tls) / scrapfly JA3/JA4 检测器

**Patch 0012: HTTP/2 帧伪装**

**触点文件**：

```
net/spdy/spdy_session.cc
net/spdy/spdy_http_stream.cc
net/third_party/quiche/src/quiche/spdy/core/hpack/hpack_encoder.cc
```

**实现要点**：
- SETTINGS 帧参数顺序 persona 绑定
- HPACK 表序伪装（与目标浏览器版本对齐）
- WINDOW_UPDATE 帧大小匹配
- PRIORITY 帧（HTTP/2 真浏览器特征）

**Patch 0013: Cookie Jar Partition**

**触点文件**：

```
services/network/cookie_manager.cc
services/network/cookie_settings.cc
net/cookies/cookie_store.cc
```

**实现要点**：
- 加 `partition_key`（基于 persona id），所有 cookie 操作携带
- 跨 partition 不可见
- IndexedDB / localStorage 同步加 partition

**Patch 0014: Persona Bridge**

在 Browser Process 中提供 `PersonaService`（KeyedService），并通过 mojom 接口推送到 Renderer：

```cpp
// chrome/browser/mosaiq/persona_service.h
class PersonaService : public KeyedService {
 public:
  static PersonaService* GetForBrowserContext(content::BrowserContext* ctx);

  // 启动时由命令行 --mosaiq-persona-id=xxx 触发加载
  void LoadFromLocal(const std::string& persona_id);
  const PersonaProfile& Get() const;

  // 给 Renderer 进程绑定 mojom 接口，让 patches 可调用 Get()
  void BindReceiver(mojo::PendingReceiver<mojom::PersonaProvider> r);

 private:
  PersonaProfile profile_;
};
```

```cpp
// Renderer 中：patches 调用这个结构子拿到 persona
class RendererPersonaCache {
 public:
  static const PersonaProfile& Get();      // 启动时从 Browser Process 拉一次，并缓存
};
```

所有 0001–0013 的 patch 都通过 `RendererPersonaCache::Get()` 拿数据。**这个 patch 是其他 patch 的基础设施**，建议第一个落地。不需要 Rust daemon 或外部 IPC。

**Patch 0015: WebUI Registration（Mosaiq 面板）**

注册 `chrome://mosaiq/*` 内部页：

**触点文件**：

```
chrome/browser/ui/webui/chrome_web_ui_controller_factory.cc      # 注册路由
chrome/browser/resources/mosaiq/                                  # WebUI 资源目录
chrome/browser/resources/mosaiq/BUILD.gn                          # build_webui_files()
chrome/browser/resources/mosaiq/mosaiq_resources.grd              # .grd
chrome/browser/ui/webui/mosaiq/mosaiq_ui.cc / .h                  # WebUIController
chrome/common/webui_url_constants.cc / .h                         # "chrome://mosaiq/" 常量
```

**实现要点**：

- React + TS 源码 → `tsc` + `webpack/rollup` → 单个 `mosaiq_app.js` + `mosaiq_app.html` → 被 `.grd` 资源包装 → 编译进主体二进制。
- WebUI 页面在 Renderer Process 中运行，通过 mojom 召叫 Browser Process 中的 `PersonaService` / `LicenseService`。
- 安全点：WebUI 页面享有高权限，严禁加载任何外网资源（CSP 锁死）。
- 调试：开发环境可启用 `--remote-debugging-port` 启 DevTools。

**参考**：Chromium 本体的 `chrome://settings`、`chrome://history` 同样机制；可拷贝 `chrome/browser/resources/settings/` 的结构作为起点。

---

## 4. 上游同步策略

### 4.1 同步频率

- **stable 通道**：每 4 周自动启动同步流程
- **security 紧急 patch**：1–3 天内手动同步（关注 [Chrome Releases blog](https://chromereleases.googleblog.com/)）

### 4.2 自动同步流程（GitHub Actions）

```yaml
# .github/workflows/upstream-sync.yml
name: Sync Upstream Chromium
on:
  schedule:
    - cron: '0 4 * * 1'   # 每周一 UTC 04:00
  workflow_dispatch:

jobs:
  detect-new-stable:
    runs-on: ubuntu-22.04-large
    steps:
      - name: Check for new stable tag
        id: check
        run: |
          NEW_TAG=$(curl -s https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Linux&num=1 | jq -r '.[0].version')
          CURR_TAG=$(cat .chromium-version)
          if [ "$NEW_TAG" != "$CURR_TAG" ]; then
            echo "new=true" >> $GITHUB_OUTPUT
            echo "tag=$NEW_TAG" >> $GITHUB_OUTPUT
          fi
      
      - name: Trigger merge job
        if: steps.check.outputs.new == 'true'
        run: gh workflow run merge-upstream.yml -f tag=${{ steps.check.outputs.tag }}

  merge-upstream:
    runs-on: self-hosted-build-128gb
    needs: detect-new-stable
    if: ${{ needs.detect-new-stable.outputs.new == 'true' }}
    steps:
      - name: Checkout fork
        uses: actions/checkout@v4
      
      - name: Fetch upstream tag
        run: |
          cd src
          git fetch origin --tags
          git checkout ${{ steps.check.outputs.tag }}
      
      - name: Re-apply patches
        run: ../scripts/apply-patches.sh
      
      - name: Build all platforms
        run: ../scripts/build-all.sh
      
      - name: Run detection regression suite
        run: ../tests/detection-suite/run.sh
      
      - name: Create PR
        run: |
          git checkout -b sync/${{ steps.check.outputs.tag }}
          git push origin sync/${{ steps.check.outputs.tag }}
          gh pr create --title "chore: sync upstream Chromium ${{ steps.check.outputs.tag }}" \
                       --body "Automated sync. CI green = merge-ready."
```

### 4.3 Patch Conflict 处理 SOP

当 `apply-patches.sh` 失败：

1. 切换到分支，手动 `git apply --3way patches/000X-*.patch`
2. 解决冲突，commit
3. 用 `git format-patch` 重新生成 patch 文件
4. 跑回归测试套件
5. 提交 PR 标注 "manual conflict resolved"

**典型冲突源**：
- Chromium 重构（如 `navigator_id.cc` 在 Chrome 130 时被拆分）
- BoringSSL 升级
- 上游对 WebRTC / Skia 的大改动

### 4.4 失败回滚机制

```yaml
# 如果新 stable 同步后检测得分大幅下降，自动回滚
- name: Detection regression check
  run: |
    SCORE=$(./tests/detection-suite/score.sh)
    PREV_SCORE=$(cat .last-good-score)
    if [ $(echo "$SCORE < $PREV_SCORE - 5" | bc) -eq 1 ]; then
      echo "Score dropped by >5 points. Rollback."
      gh workflow run rollback.yml
      exit 1
    fi
```

---

## 5. CI/CD 流水线

### 5.1 Build Matrix

| 平台 | Runner | 用时（增量） | 用时（全量） |
|---|---|---|---|
| Linux x64 | self-hosted Ubuntu 22.04 | 15 min | 4h |
| macOS x64 | self-hosted macOS 14 (M2 Max) | 20 min | 5h |
| macOS arm64 | self-hosted macOS 14 (M2 Max) | 20 min | 5h |
| Windows x64 | self-hosted Win 11 + VS 2022 | 25 min | 6h |

### 5.2 Artifact 存储

- **构建产物** → R2 bucket `mosaiq-builds/{tag}/{platform}/`
- **符号文件**（Sentry symbol upload）→ R2 + Sentry
- **签名后的安装包** → CDN（Cloudflare 边缘缓存）

### 5.3 代码签名流水线

**macOS（Notarization）**：

```bash
# 在 macOS runner 上执行
codesign --deep --force \
  --options runtime \
  --sign "Developer ID Application: Mosaiq Pte Ltd (XXXXXXXXXX)" \
  --entitlements entitlements.plist \
  out/Default/Mosaiq.app

# 打包 + notarize
ditto -c -k --keepParent out/Default/Mosaiq.app Mosaiq.zip
xcrun notarytool submit Mosaiq.zip \
  --apple-id "ops@mosaiq.io" \
  --password "$NOTARY_PASS" \
  --team-id "XXXXXXXXXX" \
  --wait
xcrun stapler staple out/Default/Mosaiq.app
```

**Windows（EV Signing）**：

```powershell
# DigiCert KeyLocker（HSM 在线签名服务）
smctl.exe sign \
  --keypair-alias "key_xxxxxx" \
  --input "out\Default\mosaiq_setup.exe" \
  --certificate certs\mosaiq.pem
```

> EV 证书 + Windows SmartScreen "声誉"积累需要 1–2 个月。第一批用户会看到 "Unknown Publisher" 警告，需要 README 教用户绕过。

### 5.4 Auto-Update

复用 Chromium 本体自带的更新机制。作为 fork，不需再引入 Tauri Updater 或 Electron Squirrel。

- **macOS**：复用 Chromium 的 [Keystone](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/updater/) 机制。需后端提供完整 Omaha-兼容 manifest XML。可接 [omaha-server](https://github.com/Crystalnix/omaha-server)（Brave 同款）。
- **Windows**：复用 Chromium 的 [Omaha](https://github.com/google/omaha)，同上，后端同款。
- **Linux**：直接打 `.deb` / `.rpm` / `.AppImage`；提供 APT / DNF repo。
- **后端 endpoint**：`https://updates.mosaiq.io/service/update2`（Omaha 协议定义 URL 路径）。
- **增量更新**：Chromium 已内置 [Courgette](https://www.chromium.org/developers/design-documents/software-updates-courgette/)（Chrome 同款极致压缩算法），复用即可。

---

## 6. 测试策略

### 6.1 检测站回归套件

每次 build 后自动跑：

```yaml
# tests/detection-suite/sites.yml
sites:
  - url: https://browserleaks.com/canvas
    selector: "#canvas-fingerprint"
    expected_unique: true
  - url: https://browserleaks.com/webgl
    expected_unique: true
  - url: https://browserleaks.com/tls
    expected_unique: true
  - url: https://creepjs-8tbo.onrender.com/
    score_threshold: 70
  - url: https://abrahamjuliot.github.io/creepjs/
    fingerprint_diff_threshold: 0.1   # 与上次得分差异 <10%
  - url: https://amiunique.org/fingerprint
    expected_unique_in_db: true
  - url: https://pixelscan.net/
    expected_natural: true
  - url: https://browserscan.net/
    expected_human: true
  - url: https://iphey.com/
    score_threshold: 90
```

每周自动运行，得分趋势写入 InfluxDB / Grafana 监控板。

### 6.2 单元 + 集成测试

- **C++ 层**：复用 Chromium 的 gtest 框架
- **mojom IPC 层**：复用 Chromium 的 `mojo::test` 框架 + 结构体序列化测试
- **WebUI / UI 层**：复用 Chromium 的 `web_ui_browser_test` 框架；并以 Playwright E2E 跑端到端场景

### 6.3 性能基准

| 指标 | 目标 | 工具 |
|---|---|---|
| 首屏渲染（FCP） | ≤ 上游 Chrome +5% | Lighthouse |
| 内存占用（10 profile） | ≤ 上游 +10% | `chrome://memory-internals` |
| CPU 占用（idle） | ≤ 上游 +5% | macOS Instruments / Linux perf |
| 启动时间 | ≤ 上游 +200ms | 自研脚本 |

> patch 不能让 Chrome "卡"，否则用户感知差。

---

## 7. 风险与已知陷阱

| 风险 | 影响 | 对策 |
|---|---|---|
| Chrome 130+ 启用 PartitionAlloc 反 hook | Patch 失效 | 跟上游同步时同步升级 patch |
| ANGLE 升级改 WebGL 实现 | Patch 0002 失效 | 长期跟踪 ANGLE PR |
| BoringSSL 重构（QUIC v2） | TLS patch 推倒 | 预留 30% 时间预算 |
| Apple Silicon 编译失败 | macOS 无法发布 | 至少 2 台 M2 Max+ build 机 |
| Linux 桌面发行版差异 | snap/flatpak 需额外打包 | v0.5 暂不支持，v1.0 处理 |
| 用户被 SmartScreen 警告吓退 | 转化率低 | EV 证书早申请 + 教程 |
| 电池 / 性能 regression | 移动用户流失 | 每个 patch 必须过性能基准 |
| 上游废弃 v8 API（Patch 引用过时 API） | 编译错误 | 每月跟 dev/canary 通道做兼容性检查 |

---

## 8. 学习资源（给 Chromium 工程师面试准备）

### 必读
- 官方 [Chromium 开发文档](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/)
- [Chromium 设计文档索引](https://www.chromium.org/developers/design-documents/)
- 《[Inside Chromium](https://www.chromium.org/developers/architecture)》系列

### 参考 fork（开源 + 学习目的）
- [ungoogled-chromium](https://github.com/ungoogled-software/ungoogled-chromium) — 反追踪 patch 集合，可借鉴 patch 组织方式
- [Brave Browser](https://github.com/brave/brave-browser) — 商业 fork 的工程范例
- [Bromite](https://github.com/bromite/bromite)（已停更但 patch 经典）
- [Cromite](https://github.com/uazo/cromite) — Bromite 的活跃延续

### 反指纹专门
- [browserleaks](https://browserleaks.com/) — 全检测维度参考
- [CreepJS 源码](https://github.com/abrahamjuliot/creepjs) — 检测库代码学习
- [FingerprintJS Pro 检测原理](https://fingerprint.com/blog/) — 最先进检测技术
- [TLS Fingerprinting 论文与文章](https://www.akamai.com/blog/security/bots-tampering-with-tls-to-avoid-detection)

---

## 9. 第一周技术 Day 0–7 行动

> 给入职第一天的内核工程师。

### Day 1
- [ ] 配置开发机：64+ GB RAM、500GB+ NVMe
- [ ] 安装 depot_tools
- [ ] 拉取 Chromium 源码（晚上挂着同步）

### Day 2
- [ ] 完成首次完整编译（约半天）
- [ ] 跑通 Chrome --version，验证产物可用
- [ ] 阅读 `docs/CHROMIUM_FORK_GUIDE.md`（这份文档）+ PRD

### Day 3
- [ ] 写 Patch 0014（Persona Bridge）骨架：`PersonaService` 返回 mock 数据
- [ ] 跑通 mojom IPC：Browser Process → Renderer 推一个 PersonaProfile 结构体
- [ ] 骨架化 Patch 0015（WebUI）：`chrome://mosaiq/hello` 返回一个静态 React 页面

### Day 4–5
- [ ] 实现 Patch 0001（Canvas Noise）最小可用版本
- [ ] 在 [browserleaks/canvas](https://browserleaks.com/canvas) 验证 fingerprint 改变

### Day 6–7
- [ ] 实现 Patch 0002（WebGL Spoof）
- [ ] 编写 patches/series.txt + apply-patches.sh
- [ ] 提交首个 PR 到 `mosaiq-chromium` 仓库

---

## 10. 评估面试候选人的 5 个技术问题

> 用这些题判断候选人 Chromium 经验是真是假。

1. **解释 Chromium 多进程架构**：browser process / renderer / GPU / utility 各自职责，IPC 类型，sandbox 层级。
2. **如果要在 `<canvas>.toDataURL` 加噪声，该改哪几个文件？**（期待答出 `html_canvas_element.cc` + `image_data.cc` 路径）
3. **Chromium 升级时 patch 冲突的 3 种典型场景**及解决（重构 / API 变更 / 依赖升级）。
4. **BoringSSL 与 OpenSSL 区别**：API 移除、ALPN 处理差异、QUIC 集成方式。
5. **gn build 系统与 ninja 的关系**：`gn gen` 做什么、`autoninja` 做什么、`is_component_build` 的代价。

---

**文档维护者**：Mosaiq 内核工程师团队  
**最近更新**：T+0  
**下次审视**：每个 Chromium stable 发布后
