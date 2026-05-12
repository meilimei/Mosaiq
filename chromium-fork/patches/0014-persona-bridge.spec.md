# Patch 0014 — Persona Bridge

**Phase**: A.2  **优先级**: P0（所有其他 patch 的基础设施）  **难度**: ⭐⭐⭐  **预期工时**: 3-4 周

## 目标

在 Browser Process 提供 `PersonaService`（绑定 BrowserContext 的 KeyedService），通过 mojom 接口推送 PersonaProfile 到所有 Renderer Process，让后续每个反检测 patch 都能通过 `RendererPersonaCache::Get()` 拿到当前 persona 数据，**不需要每个 patch 各自维护数据通道**。

## 与 SDK / persona-schema 的对齐

`PersonaProfile` C++ 结构体字段必须与 `@mosaiq/persona-schema` 的 `Persona` 类型 1:1 对应。后者已在 `packages/persona-schema/src/persona.ts` 定义。Phase A.2 实施时同步生成 `persona_profile_schema.json`（来自 schema 的 `toJSONSchema()`）作为 C++ 反序列化的契约。

## 命令行接口

```
chrome --mosaiq-persona-id=<id>
       [--mosaiq-persona-root=<path>]   # 默认 ~/.mosaiq
```

启动时 PersonaService 从 `<persona-root>/personas/<id>/persona.json` 读取 + Zod-equivalent 验证。

## 触点文件（待 A.2 时确认精确行号）

```
chrome/browser/mosaiq/                        # 新建 component
├── BUILD.gn
├── persona_service.{h,cc}                    # KeyedService 实现
├── persona_profile.{h,cc}                    # 纯数据结构
├── persona_provider.mojom                    # IDL：Browser → Renderer
├── persona_service_factory.{h,cc}            # BrowserContextKeyedServiceFactory
├── renderer_persona_cache.{h,cc}             # Renderer 端缓存
└── persona_service_unittest.cc

chrome/browser/BUILD.gn                       # 注册新 component dep
chrome/common/chrome_switches.{h,cc}          # 加 --mosaiq-persona-id flag
chrome/browser/chrome_browser_main.cc         # 启动早期加载 persona
content/public/renderer/render_thread.h       # 新增 BindPersonaProvider hook
```

## mojom IDL（草稿）

```
module mosaiq.mojom;

struct PersonaProfile {
  string id;
  string display_name;
  string os_kind;          // "windows" / "macos" / "linux"
  string os_version;
  string browser_kind;     // "chrome"
  string browser_version;
  string locale;
  string timezone;
  uint32 screen_width;
  uint32 screen_height;
  uint32 hardware_concurrency;
  uint32 device_memory_gb;
  string canvas_seed;       // 给 patch 0001 用
  string webgl_renderer;    // 给 patch 0002 用
  string ja4_target;        // 给 patch 0011 用
  // ... 其他字段对齐 packages/persona-schema/src/persona.ts
};

interface PersonaProvider {
  // Renderer 启动时同步 RPC 一次拿到 persona，缓存全生命周期
  GetPersona() => (PersonaProfile profile);
};
```

## 单元测试

- `persona_service_unittest.cc`
  - 加载有效 JSON → 字段都对
  - 加载非法 JSON → 不崩，返回空 profile + 写日志
  - 切换 BrowserContext → 各自隔离的 PersonaService
- 集成测试（browser_test）
  - `chrome --mosaiq-persona-id=test-001` 启动后，DevTools console 发 RPC 拿到对应 profile

## Done condition

```bash
./out/Default/chrome \
  --mosaiq-persona-id=test-001 \
  --no-sandbox

# 在 DevTools console：
# > await window.chrome.mosaiq.getPersona()
# < { id: "test-001", os_kind: "windows", ... }
```

## 增量 build 时间预估

每改一个 .cc/.h → autoninja chrome 增量编译 + 链接。HDD 上：

- 单 .cc 改动 → 5-15 min（component_build 下只重链接相关 .so）
- 改了 mojom IDL → 全 mojom 重生成 + 多个 .so 重链 → 30-60 min
- 改了 chrome/browser/BUILD.gn → 几乎全量重链 → 1-2h

## 风险点

1. **mojom 接口设计错** → 后续 patch 全部要重新接 → 一定要先把 PersonaProfile 字段定全，参照 `@mosaiq/persona-schema` 现状
2. **Service 生命周期不对** → BrowserContext 销毁时 leaked → 用 `KeyedServiceFactory` 标准模式
3. **Renderer 启动竞态** → patch 在 cache 准备好前 query → `RendererPersonaCache` 提供同步 RPC（阻塞 < 100ms）

## 参考

- `docs/CHROMIUM-FORK-GUIDE.md` §3 Patch 0014
- Chromium 现有 KeyedService 范例：`chrome/browser/profiles/profile_keyed_service_factory.h`
- Chromium 现有 mojom 范例：`components/translate/content/common/translate.mojom`
