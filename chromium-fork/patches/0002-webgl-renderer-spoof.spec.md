# Patch 0002 — WebGL Renderer Spoof (native)

**Phase**: A.5+（v1.0 解冻后） **优先级**: P2 **难度**: ⭐⭐⭐ **预期工时**: 2-3 周

## 目标

在 ANGLE / GPU 进程层伪造 GL_VENDOR / GL_RENDERER 真实字符串 + 49-param capabilities，**取代 SDK 注入版**（`packages/sdk/src/injection/runner.ts` §4 + `webgl-profiles.ts`）。

## 为什么需要 native patch？

### SDK 注入版的局限

1. **wrapStealth + Function.prototype.toString reverse 风险**：
   - SDK 注入版在 `WebGLRenderingContext.prototype.getParameter` 上装 Proxy
   - `Function.prototype.toString.call(getParameter)` 必须返回原 `[native code]` 字符串
   - 当前实现用 `stealthRegistry` 缓存原 toString，全局 hook 覆盖
   - **enterprise detector** 可以做更深的反检测：
     - 比较 `Reflect.getOwnPropertyDescriptor(WebGLRenderingContext.prototype, 'getParameter')` 在 frozen prototype 上的位置/可见性
     - 用 iframe 内的原生 prototype 做 cross-realm 对比（contentWindow.WebGLRenderingContext.prototype.getParameter !== top.WebGLRenderingContext.prototype.getParameter）
     - V8 perf timing：Proxy 调用比 native 慢一个 ns 量级，detector 可用 performance.now() diff 测出

2. **49-param 漏覆盖**：当前 `webgl-profiles.ts` 只覆盖 49 个 "CreepJS short list" param。
   - WebGL spec 定义 ~150 个 getter param
   - Enterprise detector 可能查 49-param 之外的 surface（如 `MAX_VERTEX_OUTPUT_COMPONENTS`、`MAX_FRAGMENT_INPUT_COMPONENTS` 在某些 detector 已扩展查询）

3. **Worker scope mirror cost**：Phase 2.6 worker IIFE 复刻一次，每个 Worker 构造都要 spawn blob URL + reload。性能开销 + CSP `script-src 'self'` 严格站点 fail。

### Native patch 优势

- **零 Proxy overhead**：直接在 C++ 层替换返回值，无 toString reverse 风险
- **覆盖全 150 param**：在 `gpu/command_buffer/service/gles2_cmd_decoder.cc` 拦截所有 GL_* getter，不需要枚举
- **跨 realm / cross-origin iframe 自动 mirror**：所有 frame 共享同 GPU process，spoof 自动跨 realm 一致
- **CSP 无碍**：browser-level patch 不通过 JS init script，CSP 不适用

---

## 触点文件（待 v1.0 时确认精确行号）

```
gpu/command_buffer/service/
├── gles2_cmd_decoder.cc                  # GLES2DecoderImpl::DoGetIntegerv / DoGetString
├── gles2_cmd_decoder_passthrough.cc      # PassthroughDecoder (ANGLE backend)
└── feature_info.cc                       # ExtensionInfo / Capabilities init

third_party/angle/src/libANGLE/
├── Context.cpp                           # Context::getStringi / getIntegerv
└── renderer/d3d/d3d11/                   # D3D11 backend renderer 字符串

content/browser/gpu/
└── gpu_data_manager_impl.cc              # GPU info 跨进程 IPC

chrome/browser/mosaiq/
├── persona_service.cc                    # PersonaProfile.webgl_renderer 字段
└── gpu_persona_bridge.cc                 # 新建：传 persona webgl override 到 GPU process
```

## 方案设计

### 阶段 1：Renderer process 接收 persona webgl override（依赖 patch 0014）

`RendererPersonaCache::Get()->webgl_renderer` / `webgl_vendor` / `webgl_caps` 已通过
patch 0014 mojom 在 renderer 启动时同步过来。

### 阶段 2：注册 GPU 进程级 hook

```cpp
// content/browser/gpu/gpu_persona_bridge.cc (新建)
class GpuPersonaBridge {
 public:
  static GpuPersonaBridge* Get();
  void SetPersonaWebGLOverride(
      const std::string& vendor,
      const std::string& renderer,
      const base::flat_map<GLenum, GLValueVariant>& caps);
  const std::string& GetVendor() const { return vendor_; }
  const std::string& GetRenderer() const { return renderer_; }
  const GLValueVariant* GetCap(GLenum pname) const;
 // ...
};
```

启动时从 RendererPersonaCache 读 persona webgl 字段，调 `SetPersonaWebGLOverride`。

### 阶段 3：在 GLES2 decoder 拦截 GetString / GetIntegerv / GetFloatv

```cpp
// gpu/command_buffer/service/gles2_cmd_decoder.cc
error::Error GLES2DecoderImpl::HandleGetString(
    uint32_t immediate_data_size, const volatile void* cmd_data) {
  // ... 原有解码 ...
  GLenum name = static_cast<GLenum>(c.name);

  // ── Mosaiq 拦截 ──
  if (auto* bridge = GpuPersonaBridge::Get()) {
    if (name == GL_VENDOR && !bridge->GetVendor().empty()) {
      return ReturnString(bridge->GetVendor());
    }
    if (name == GL_RENDERER && !bridge->GetRenderer().empty()) {
      return ReturnString(bridge->GetRenderer());
    }
  }
  // ── 原有 forward ──
  return ForwardToANGLE(name);
}

error::Error GLES2DecoderImpl::HandleGetIntegerv(
    uint32_t immediate_data_size, const volatile void* cmd_data) {
  GLenum pname = ...;
  if (auto* bridge = GpuPersonaBridge::Get()) {
    if (auto* val = bridge->GetCap(pname); val && val->is_int()) {
      return ReturnInt(val->as_int());
    }
  }
  return ForwardToANGLE(pname);
}
```

类似覆盖 `HandleGetFloatv` / `HandleGetIntegeri_v` / `HandleGetString_i`（WebGL2 string indexed）等。

### 阶段 4：UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL 扩展

WebGL 标准 GL_VENDOR/GL_RENDERER 通常返回 "WebKit"/"WebKit WebGL"（同 SDK 注入版）。
真实 GPU 信息通过 WEBGL_debug_renderer_info extension 的 `UNMASKED_VENDOR_WEBGL` (0x9245) /
`UNMASKED_RENDERER_WEBGL` (0x9246) 查询，需要在 GLES2 decoder 上单独拦截这两个 pname。

```cpp
case GL_UNMASKED_VENDOR_WEBGL:
  return ReturnString(bridge->GetUnmaskedVendor());
case GL_UNMASKED_RENDERER_WEBGL:
  return ReturnString(bridge->GetUnmaskedRenderer());
```

## 单元测试

- `gpu/command_buffer/service/gles2_cmd_decoder_unittest.cc` 加 `GetStringWithPersona` test：
  - 设 persona vendor="Google Inc." renderer="ANGLE ..."
  - 调 `glGetString(GL_VENDOR)` → 期望 spoofed
  - `glGetString(GL_VERSION)` → 期望 forward 原 ANGLE 值（version 不 override）
- Integration test (`browser_test`)：launch chrome --mosaiq-persona-id=test-nvidia → DevTools console `gl.getParameter(0x9245)` 返回 NVIDIA 字符串

## Done condition

```bash
./out/Default/chrome \
  --mosaiq-persona-id=test-nvidia-rtx3060 \
  --no-sandbox \
  --disable-gpu-sandbox  # 调试方便

# DevTools console：
> const gl = document.createElement('canvas').getContext('webgl')
> gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)
< "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"

> gl.getParameter(0x0d33)  // MAX_TEXTURE_SIZE
< 16384

# 关键：toString reverse 不出端倪
> gl.getParameter.toString()
< "function getParameter() { [native code] }"  // 原 native，没有任何 Proxy 痕迹
```

## 与 SDK 注入版的关系

- **不删除** SDK 注入版（`runner.ts` §4 + `webgl-profiles.ts`）—— 仍然是免 fork 用户的兜底
- chromium-fork 版本启动时 detect `chrome.mosaiq.persona`（PersonaService 注入），如有则**禁用 SDK 注入版**避免双重 spoof
- `apps/desktop` 启动时按 `chrome --version` 判断是否含 Mosaiq build flag，决定是否注入 SDK 版

## 增量 build 时间预估

每改一个 `gles2_cmd_decoder.cc` → autoninja 增量编译 + 链接 GPU process。HDD 上：
- 单 .cc 改动 → 10-30 min（GPU 库较大）
- 改了 `feature_info.cc` 公共 header → 30-60 min（多个 .so 重链）

## 风险点

1. **ANGLE 反向校验**：ANGLE 内部 D3D11 backend 可能有 sanity check（vendor 与底层 device 不匹配则抛错）→ 测试时观察 chrome://gpu 是否报错
2. **多 GPU 进程**：Chromium 在 process per origin 模式下可能 spawn 多 GPU process → GpuPersonaBridge 需要 process-singleton
3. **Crash 风险**：拦截 decoder 必须确保 fallback path 完整 forward 原 ANGLE，否则 page crash
4. **GREASE 一致性**：spoof "NVIDIA RTX 3060" 但 dispatching 仍是真 Intel GPU 渲染，detector 用 readPixels + shader 校验可能不一致 — 但 SDK 注入版同样问题，patch 0002 不解决这个（需要 GPU process emulation patch v2.0）

## 参考

- `packages/sdk/src/injection/webgl-profiles.ts` — 49-param 参数表（patch 用同源数据）
- `packages/sdk/bench/verify-creepjs-profile-hash.ts` — CreepJS 白名单验证工具
- ANGLE D3D11 backend source: `third_party/angle/src/libANGLE/renderer/d3d/d3d11/`
- Chromium GLES2 decoder spec: `gpu/command_buffer/service/gles2_cmd_decoder.md`
