# Patch 0016 — Headless Detection Bypass (native)

**Phase**: A.6+（v1.0 解冻后） **优先级**: P2 **难度**: ⭐⭐⭐ **预期工时**: 1-2 周

## 目标

在 Chromium native 层删除所有 headless 显式标识。`--headless=new` 模式即使配合 SDK 注入 spoof UA，仍有以下 native-level 暴露面：

1. **`Page.IsAutomatedTask` CDP method** 返回 true（CDP 协议级标识）
2. **`HeadlessChrome` UA fragment**（即使 launch flag 改，部分 sub-component 仍硬编码）
3. **`--enable-automation` flag** 内部状态（`base::CommandLine::HasSwitch`）暴露给 renderer
4. **GPU process disabled** when `--headless` → `chrome://gpu` 显示 "Disabled" / WebGL2 = "Disabled"
5. **`navigator.serviceWorker` undefined** in `--headless` mode（service worker disabled by default）

SDK 注入修不到 1 / 3 / 4，部分修到 5（Phase 1.5 hook navigator.serviceWorker.register），完全修到 2（UA spoof）。

## 触点文件（待 v1.0 时确认精确行号）

```
content/browser/devtools/protocol/page_handler.cc      # Page.* CDP method
content/browser/devtools/protocol/runtime_handler.cc   # Runtime.* CDP method (isAutomated)
chrome/browser/headless/headless_mode_util.cc          # IsHeadlessMode() helpers
content/browser/renderer_host/render_process_host_impl.cc  # AutomationControlled flag 传 renderer
chrome/browser/chrome_browser_main.cc                  # --enable-automation flag 处理
content/public/common/content_features.cc              # IsHeadlessChromeNewModeEnabled
```

## 方案设计

### 阶段 1：CDP method 强制返回 false

```cpp
// content/browser/devtools/protocol/page_handler.cc
Response PageHandler::IsAutomatedTask(bool* out_automated) {
  // 原：return *out_automated = command_line.HasSwitch(switches::kEnableAutomation);
  if (IsMosaiqPersonaActive()) {
    *out_automated = false;  // 强制 false
    return Response::Success();
  }
  // ── 原 fallback ──
  *out_automated = base::CommandLine::ForCurrentProcess()
                       ->HasSwitch(switches::kEnableAutomation);
  return Response::Success();
}
```

类似处理 `Runtime.evaluate` 检测的 `automated:` 字段。

### 阶段 2：UA HeadlessChrome 替换全 source

```bash
# 在 chromium/src 内 grep 所有 HeadlessChrome 硬编码
grep -rn "HeadlessChrome" --include='*.cc' --include='*.h' \
  components/ content/ chrome/ third_party/blink/
```

预期触点：
- `content/public/common/user_agent.cc` 主 UA 字符串
- `services/network/public/cpp/server_certificate_verifier_request_factory.cc` 内部 logging
- `content/browser/devtools/protocol/network_handler.cc` UA-CH spoof

在 PersonaService active 时替换为 `Chrome/{major}.0.0.0`。

### 阶段 3：`--enable-automation` flag 内部隔离

Mosaiq persona 路径下，`PersonaService` 在 BrowserContext 初始化时**显式 disable** `kEnableAutomation` switch 给 renderer process 看：

```cpp
// content/browser/renderer_host/render_process_host_impl.cc
void RenderProcessHostImpl::AppendRendererCommandLine(
    base::CommandLine* command_line) {
  // ... 原有 forward 逻辑 ...
  if (mosaiq::PersonaServiceFactory::HasActive(GetBrowserContext())) {
    command_line->RemoveSwitch(switches::kEnableAutomation);
    command_line->RemoveSwitch("test-type");
    command_line->RemoveSwitch("remote-debugging-pipe");
    // 关键：不让 renderer 内 V8 检测到 automation 痕迹
  }
}
```

### 阶段 4：navigator.webdriver = false in WebPreferences

虽然 SDK 注入版用 `defineProtoGetter('webdriver', false)` 已 spoof，但 Blink 内部 `Navigator::webdriver()` IDL method 仍读 `RenderThreadImpl::GetRendererBlinkPlatform()->IsAutomationControlled()` → 在 main world 之前的早期检测可能漏。

```cpp
// third_party/blink/renderer/core/frame/navigator.cc
bool Navigator::webdriver() const {
  if (mosaiq::IsPersonaActive())
    return false;  // 强制 false
  return RuntimeEnabledFeatures::AutomationControlledEnabled() ||
         Platform::Current()->IsAutomationControlled();
}
```

### 阶段 5：WebGL2 / SW / GPU 不因 --headless disable

`--headless=new` 模式默认禁用 SW + GPU。但 Mosaiq 用户用 `--headless` 仅出于 unattended mode，不应禁这两个。

`headless_mode_util.cc`：
```cpp
bool IsServiceWorkerEnabledInHeadlessMode() {
  if (mosaiq::IsPersonaActive())
    return true;  // 强制启用
  return base::FeatureList::IsEnabled(kHeadlessChromeNewServiceWorkers);
}
```

## 单元测试

- `chrome/browser/devtools/protocol/page_handler_unittest.cc` 加 test：
  - PersonaService active + `--enable-automation` → `IsAutomatedTask` 返回 false
  - PersonaService inactive + `--enable-automation` → 返回 true（兼容原行为）
- `browser_test` `chrome --mosaiq-persona-id=foo --headless=new` 启动：
  - DevTools console `navigator.webdriver === false`
  - WebGL2 context 可创建（非 disabled）
  - SW register 不抛 error

## Done condition

```bash
./out/Default/chrome \
  --mosaiq-persona-id=test-001 \
  --headless=new \
  --enable-automation \
  --remote-debugging-port=9222

# 用 CDP client 跑 detection：
cat <<'EOF' | curl -s -X POST localhost:9222/json -d @-
{"method":"Page.isAutomatedTask"}
EOF
# < {"result":{"automated":false}}

# JS detection（用 Page.evaluate）：
> typeof navigator.webdriver
< "boolean"
> navigator.webdriver
< false
> /HeadlessChrome/i.test(navigator.userAgent)
< false
> document.createElement('canvas').getContext('webgl2') !== null
< true
> 'serviceWorker' in navigator
< true
```

## 与 SDK 注入版的关系

SDK 注入版 (`runner.ts` §1) 已 spoof `navigator.webdriver=false`，但**早于** main world 注入的 IDL 检测路径仍漏（如 service worker 注册时的 navigator inheritance）。Native patch 把这条洞从源头堵上。

## 增量 build 时间预估

- `page_handler.cc` 改动：5-10 min 重链
- `user_agent.cc` 改动 + 多文件 `HeadlessChrome` 替换：15-30 min（涉及 content/ + chrome/ 多个 component）
- WebPreferences 改动：20-40 min（content/browser 大 lib）

## 风险点

1. **CDP 协议 backward compat**：第三方 CDP 客户端（如 puppeteer）依赖 `Page.IsAutomatedTask` 返回 true 做自动化检测 → 我们的 patch 让其 false，可能破坏 puppeteer 自身。**只在 PersonaService active 时生效**，正常 puppeteer 使用不受影响。
2. **`HeadlessChrome` 在某些 fingerprint database 是 expected**：如果 detector 期望"现代用户禁用了 puppeteer 时仍带 HeadlessChrome" 反推为 bot，我们移除反而暴露。**需要 v1.0 真站测试验证**。
3. **GPU process enable 在 --headless 下可能不稳定**：Linux + 无 X server 环境下强行启 GPU 进程可能 crash。需要 fallback to swiftshader software renderer。
4. **隐藏 automation 也是合规风险**：某些 jurisdiction 要求 automated request 明确标识。Mosaiq 应在 ToS 里说明。

## 参考

- `packages/sdk/src/injection/runner.ts:294-432` SDK navigator.webdriver spoof
- `chromium-fork/STATUS.md` §3.1 解冻条件
- Chromium DevTools Protocol: `content/browser/devtools/protocol/`
- Headless mode util: `chrome/browser/headless/`
