# 从 Shieldly 迁移指南

> **目标**：明确 Shieldly 现有代码哪些可以直接搬到 Mosaiq、哪些需要重写、哪些必须丢弃。
>
> **原则**：Mosaiq 是新产品，**不是 Shieldly 重构版**。复用的资产仅限于"通用工程基座"，业务逻辑全部重新设计。

---

## 0. 速览：复用矩阵

> **架构前提**：Mosaiq 是单二进制 Chromium fork，无 Tauri/Electron 壳。所以“迁到 TS 包”仅限于面向开发者的 SDK；产品内部的 license / storage / crypto **全部迁到 Chromium Browser Process 的 C++ Services**。

| Shieldly 模块 | Mosaiq 复用度 | 迁入位置 | 处理方式 |
|---|---|---|---|
| `src/shared/license.ts` | ⭐⭐⭐⭐ 80% | C++ `chrome/browser/mosaiq/license_service.cc` | 业务流程逐行重写 C++；Creem API 调用、grace period、instance ID 逻辑保留 |
| `src/shared/crypto.ts` | ⭐⭐ 30% | 产品内部：换用 Chromium `OSCrypt`；SDK 包：保留 TS 版本 | 产品内不再自写 AES-GCM；但 SDK / profile 导出场景仍需 TS版 加密 |
| `public/_locales/{en,zh_CN}/messages.json` | ⭐⭐⭐⭐ 80% | Chromium `.grd` / `.xtb` 文案体系 | 转换格式，但中英翻译作为种子 |
| `src/shared/types.ts` 中 License 类型 | ⭐⭐⭐⭐⭐ 100% | C++ struct + `.mojom` 接口；SDK 端 TS | 同一份语义，三处代码同步（C++/TS/mojom） |
| `src/shared/types.ts` 中 FingerprintConfig | ⭐⭐ 30% | C++ Persona schema | 概念延续，schema 重新设计（per-persona 而非 per-site） |
| `src/shared/types.ts` 中 SiteRule | ⭐ 10% | — | 概念报废（Mosaiq 是 per-persona 不是 per-site） |
| `src/shared/storage.ts` | ⭐ 10% | C++ `PersonaService` 内部用 Chromium `sql::Database` | 概念延续（加密默认开、导出入格式），代码重写 |
| `src/shared/identity-generator.ts` | ⭐ 0% | — | 完全报废；Persona 来自云端真机库 |
| `src/shared/privacy-grade.ts` | ⭐⭐⭐ 50% | C++ Detection Lab Runner + WebUI 展示 | 改造为 "Profile Health Score"（0–100分） |
| `src/shared/constants.ts` 中 CREEM_CONFIG | ⭐⭐⭐⭐⭐ 100% | C++ `LicenseService` 常量 | 直接移植值（同一支付商）；但 product ID 全换新 |
| `src/shared/trackers.generated.ts` | ⭐ 0% | — | **完全报废**——Mosaiq 反过来不应阻挡 trackers |
| `src/entrypoints/background.ts` 指纹注入 | ⭐ 0% | — | **完全报废**——逻辑下移到 Chromium C++ patch |
| `src/entrypoints/popup/` React UI 设计 | ⭐⭐⭐ 50% | WebUI 面板 `chrome/browser/resources/mosaiq/` | 设计语言保留，组件重新组织（从 popup 350×500 变为面板 1280×800） |
| `wxt.config.ts` | ⭐ 0% | — | 报废 |
| `tests/crypto.test.ts` | ⭐⭐⭐ 50% | — | 产品内 OSCrypt 进入 Chromium 自身测试；SDK 侧仍保留为参考 |
| `tests/license.test.ts` | ⭐⭐⭐⭐ 80% | 重写为 Chromium gtest | 测用例代码不能直接跑，但场景覆盖目录价值高 |

---

## 1. 主迁移（产品内部 C++ 实现）

> 下述 license / crypto / storage 逻辑全部迁到 Chromium Browser Process 中的 C++ Services，路径与命名参考 [CHROMIUM-FORK-GUIDE.md](./CHROMIUM-FORK-GUIDE.md) §2 仓库结构。

### 1.1 `license.ts` → C++ `LicenseService`

**Shieldly 源**：`@d:/projects/Shieldly/src/shared/license.ts:1-299`

**迁入位置**：`chromium-fork/src/chrome/browser/mosaiq/license_service.{h,cc}`

**迁移手法：逐函数重写 C++**：

```cpp
// chrome/browser/mosaiq/license_service.h
class LicenseService : public KeyedService {
 public:
  void ActivateAsync(const std::string& key,
                     base::OnceCallback<void(LicenseInfo)> cb);
  void DeactivateAsync(base::OnceCallback<void(bool)> cb);
  void ValidateAsync(base::OnceCallback<void(LicenseInfo)> cb);
  const LicenseInfo& Current() const;

 private:
  // 对应 Shieldly proxyRequest()
  void CallCreemApi(const std::string& path,
                    base::Value::Dict body,
                    base::OnceCallback<void(base::Value::Dict)> cb);

  // 对应 Shieldly storage。加密走 OSCrypt
  std::string LoadEncrypted();
  void SaveEncrypted(const std::string& blob);

  LicenseInfo info_;
};
```

**保留逻辑**：

- 全部 Creem API endpoint 与 payload schema。
- Activate / Deactivate / Validate 三者调用顺序与错误处理。
- Grace period（离线宽限）。
- Instance ID 生成：从实例 ID 生成补为 `(machine_fingerprint, instance_uuid)` 二元组，防同一 license 多机启动。
- Dev test key 在 `is_chrome_branded=false` 构建中保留。

**调整**：

- 离线宽限期从 7 天 → 14 天（桌面端用户期望高于插件）。
- HTTP 库用 Chromium 自带 `network::SimpleURLLoader`。
- 并发验证锁：用 `base::SequenceCheckerImpl` 防 race。

### 1.2 `crypto.ts` → 产品内换用 `OSCrypt`；SDK 侧保留

**产品内部（LicenseService / PersonaService 的本地存储）**：

- 不再自实现 AES-GCM。直接调用 Chromium 提供的 `OSCrypt::EncryptString` / `DecryptString`。后端：macOS Keychain / Windows DPAPI / Linux KWallet+GNOME。
- Chromium 本体的质量远高于手写 AES-GCM，且受平台本身保护。

**SDK 包（`packages/sdk-typescript/`）保留 TS 版**：

- 场景：开发者在 Mosaiq 外部处理加密后的 profile 导出文件、跨设备同步。
- 代码：从 `@d:/projects/Shieldly/src/shared/crypto.ts` 拷贝，去掉 `chrome.storage.local` 依赖，提供 `KVStore` 接口供依赖注入。

### 1.3 LicenseInfo / LicenseTier 类型 → 三处同步

**Shieldly 源**：`@d:/projects/Shieldly/src/shared/types.ts:131-160`

**迁入位置**：三处代码同步定义。

1. **C++ struct**：`chrome/browser/mosaiq/license_types.h`
2. **mojom 接口**：`chrome/browser/mosaiq/mojom/license.mojom`——供 WebUI 面板 调用
3. **TypeScript SDK**：`packages/sdk-typescript/src/types.ts`——供外部开发者

**同步机制**：在 mojom 中定义，用 `mojom.bindings.tsgen` 生成 TS 类型供 SDK / WebUI 使用，避免三处人工同步错位。

### 1.4 Creem 配置常量 → C++ 常量

**Shieldly 源**：`@d:/projects/Shieldly/src/shared/constants.ts`

**迁入位置**：`chrome/browser/mosaiq/license_constants.cc`

**改动**：

- API base URL、endpoint 路径、payload 字段名直接复制。
- `CREEM_PRODUCT_IDS` 全部重建（在 Creem 后台为 Mosaiq 主体创建新产品，拿新 ID）。
- 补充：Creem webhook signature 验证（Shieldly 只走客户端调用，未实现 webhook）。

### 1.5 i18n 文案 → Chromium `.grd` / `.xtb` 文件系统

**Shieldly 源**：

- `@d:/projects/Shieldly/public/_locales/en/messages.json`
- `@d:/projects/Shieldly/public/_locales/zh_CN/messages.json`

**迁入位置**：

- 主以 `chromium-fork/src/chrome/app/resources/mosaiq_strings.grd` + 各语言 `mosaiq_strings_zh-CN.xtb` / `mosaiq_strings.xtb`。
- WebUI 面板 使用同一资源，通过 Chromium 的 `loadTimeData.getString()` 读取。

**转换脚本**：写一个小脚本 `tools/i18n/convert-mv3-to-grd.ts`，输入 Chrome MV3 messages.json，输出 `.grd` 主文件 + 各语言 `.xtb`。

### 1.6 SDK 依赖表 → 独立 npm 包

**Shieldly 没有 SDK**，但 Mosaiq Dev-First 策略要求发一套 `@mosaiq/sdk`。SDK 可复用 Shieldly 的：

- TypeScript build / lint / test 配置（`tsconfig.json`、`eslint`、`vitest` 选型）。
- `pnpm` workspace 结构。
- crypto.ts（见 §1.2）。
- LicenseInfo / Persona 类型（见 §1.3）。

---

## 2. 重构后移植（2 个模块）

### 2.1 `storage.ts` → C++ `PersonaService` 内部存储层

**Shieldly 源**：`@d:/projects/Shieldly/src/shared/storage.ts`（TypeScript + chrome.storage.local）

**Mosaiq 重写**：用 C++ 实现，后端用 Chromium 自带 `sql::Database`（每个 profile 独立 db 文件）。

```cpp
// chrome/browser/mosaiq/profile_storage.h
class ProfileStorage {
 public:
  explicit ProfileStorage(const base::FilePath& db_path);

  std::optional<PersonaProfile> GetPersona(const std::string& profile_id);
  std::vector<ProfileMeta> ListProfiles();
  std::vector<uint8_t> ExportEncrypted(const std::string& profile_id);
  std::string ImportEncrypted(base::span<const uint8_t> data);

 private:
  sql::Database db_;
  // 加密走 OSCrypt。不自实现 AES-GCM
};
```

**保留概念**：
- 加密存储默认开
- 导入导出格式同 Shieldly（表样可互识别，不互通）

**丢弃概念**：
- `chrome.storage.local` 5MB 同步限制。
- `seedRotatedAt` 旋转机制（Mosaiq 不旋转，persona 一旦生成即冻结）。
- AES-GCM 256 算法自实现——改用 OSCrypt。

### 2.2 `privacy-grade.ts` → Detection Score Engine

**Shieldly 源**：`@d:/projects/Shieldly/src/shared/privacy-grade.ts`（A+/A/B/C/D/F 评级）

**Mosaiq 改造**：变成 "Profile Health Score"，0–100 分，反映：
- 当前 persona 一致性（+30 分）
- 最近 Detection Lab 检测得分（+40 分）
- Cookie / Storage 完整度（+15 分）
- IP 信誉（+15 分，调用 IP 检查 API）

**算法草稿**：

```ts
// packages/core-fingerprint/src/health-score.ts
export interface HealthScoreInputs {
  persona: PersonaProfile;
  detectionLabResults: DetectionLabResult[];
  cookieIntegrity: number;     // 0-1
  ipReputation?: IpReputation;
}

export function computeHealthScore(inputs: HealthScoreInputs): HealthScore {
  // ... 加权求和
}
```

### 2.3 React UI 组件 → Chromium WebUI

**Shieldly 源**：`@d:/projects/Shieldly/src/entrypoints/popup/`

**迁入位置**：`chromium-fork/src/chrome/browser/resources/mosaiq/`，面板到1 Chromium WebUI（`chrome://mosaiq/...`）。

**Mosaiq 改造**：
- **保留**：颜色系统（暗色优先）、Tailwind 配置、Lucide icons 选型。
- **重写**：所有 layout（popup 350×500 → 面板 1280×800）。
- **数据层替换**：Zustand store 改为 `mojom` 调用（WebUI 页面跳一个全局 mojom 实例，调 Browser Process 中的 PersonaService / LicenseService）。不再使用 React Query + WebSocket / Tauri IPC。
- **构建链**：Chromium 提供 `build_webui_files()` GN 函数处理 React + TS，复用 Chromium上游的 `chrome://settings` 构建脚手架。

**可直接搬的小组件**：
- `Toast` 通知组件
- `Tooltip` 设计
- `Toggle` switch
- `Badge` 标签

---

## 3. 完全报废（5 个模块）

### 3.1 `identity-generator.ts`

**为什么报废**：
- 生成 `.test`/`.example` 邮箱（PRD §2 已论证此为反向资产）
- 演示用卡号
- 随机姓名地址

Mosaiq 反过来：persona 来自**真实采集的设备指纹库**（云端下发），不是程序生成的随机数据。

### 3.2 `trackers.generated.ts` + DNR 阻挡逻辑

**为什么报废**：
- Mosaiq 不阻挡 trackers——平台看不到自家 analytics 反而判异常（详见 PRD §1.3）
- ~30k 行 tracker 域名列表与产品定位冲突

### 3.3 `wxt.config.ts` + 整个 Chrome Extension 框架

**为什么报废**：Mosaiq 是桌面 App，不是 MV3 扩展。

### 3.4 `background.ts` 中 `injectFingerprintSpoofing`

**为什么报废**：
- 逻辑下移到 Chromium C++ patch（详见 [CHROMIUM-FORK-GUIDE.md](./CHROMIUM-FORK-GUIDE.md) §3）
- JS 层 hook 容易被反检测

**作为研究素材保留**：
- 哪些 navigator 属性需要伪装的清单
- Audio/Canvas/WebGL 噪声策略思路
- 这些**思路**是宝贵的；**实现**全部重写

### 3.5 SiteRule / 站点白名单 / Smart Mode

**为什么报废**：
- Mosaiq 的 fingerprint 绑定在 **persona** 上而不是 **site** 上
- 用户切 persona = 切身份；不是开关 protection level
- "智能模式"（敏感站点降级）在养号场景反而是反向需求

---

## 4. 迁移执行步骤（具体）

### Phase 0 期（本月）

**先决条件**：`mosaiq-chromium` 仓库骨架已建（见 [CHROMIUM-FORK-GUIDE.md §2](./CHROMIUM-FORK-GUIDE.md)）。

**Step 1**：创建 SDK npm 包骨架

```bash
cd d:\projects\Mosaiq
mkdir -p packages\sdk-typescript\src
cd packages\sdk-typescript
pnpm init
# 依赖：纯 TS，制品面向 Node + 浏览器双环境
```

**Step 2**：迁 crypto.ts 进 SDK（仅供外部开发者使用）

```bash
Copy-Item "d:\projects\Shieldly\src\shared\crypto.ts" `
         "d:\projects\Mosaiq\packages\sdk-typescript\src\crypto.ts"
# 修改：去掉 chrome.storage.local 依赖，提供 KVStore 接口
```

**Step 3**：迁测试集

```bash
New-Item -Type Directory "d:\projects\Mosaiq\packages\sdk-typescript\tests"
Copy-Item "d:\projects\Shieldly\tests\crypto.test.ts" `
         "d:\projects\Mosaiq\packages\sdk-typescript\tests\"
Copy-Item "d:\projects\Shieldly\tests\setup.ts" `
         "d:\projects\Mosaiq\packages\sdk-typescript\tests\"
Set-Location "d:\projects\Mosaiq\packages\sdk-typescript"
pnpm test
```

**Step 4**：抱 license.ts 到 “参考实现档案库”

不在 SDK 包中迁进产品主干；复制一份到 `chromium-fork/docs/reference/shieldly-license-original.ts`，供后续 C++ 重写中逐行对照。

```bash
Copy-Item "d:\projects\Shieldly\src\shared\license.ts" `
         "d:\projects\Mosaiq\chromium-fork\docs\reference\shieldly-license-original.ts"
```

### M2 期（月 3）

- C++ `LicenseService` 骨架落地，能调通 Creem dev test key。
- 迁 `_locales/*.json` 到 `mosaiq_strings.grd` + `.xtb`。

### M5 期（月 9）

- WebUI 面板骨架能跳起。Profile Manager 面板重用 Shieldly 的 Toast / Tooltip / Toggle / Badge 组件设计（代码拷入 `chrome/browser/resources/mosaiq/components/`）。
- 当 Persona / Profile 模型稳定后，同步 LicenseInfo / Persona 类型到 SDK。

---

## 5. 法务 / 知识产权注意事项

### 5.1 代码所有权

Shieldly 与 Mosaiq 是**同一创始人（你）拥有的两个产品**，复用 Shieldly 代码无 IP 障碍。

但建议：

1. 在 `packages/core-storage/LICENSE` 注明：
   ```
   Portions of this code are derived from Shieldly project
   (https://github.com/dejianli/shieldly), Copyright (c) 2025 Dejian Li.
   Used and re-licensed under the same author's authority.
   ```

2. **Phase 0 法务文件**（PRD §1.3）应在创始人协议中明确：
   - Shieldly 代码资产可以无偿迁移到 Mosaiq 实体
   - 反向不允许（Mosaiq 新代码不自动归 Shieldly 实体所有）

### 5.2 Creem 账户

- 不要在 Mosaiq 复用 Shieldly 的 Creem product ID
- 在 Creem 后台为 Mosaiq 实体新建产品 + API 密钥
- Mosaiq 用户的购买流水与 Shieldly 完全独立

### 5.3 用户数据隔离

Shieldly 现有用户的数据**不应迁移**到 Mosaiq：
- License 不通用
- profile 数据格式完全不同
- 隐私政策签订主体不同

但可以在 Shieldly settings 加一个温和的 "看看我们的姊妹产品 Mosaiq" 入口（PRD §6.2 交叉导流）。

---

## 6. 复用清单 Checklist

> 复制到 Linear / Notion，逐项推进。

### 产品主干（Phase 0 ~ M2）——逐行重写为 C++
- [ ] 创建 `chrome/browser/mosaiq/` component 骨架
- [ ] `LicenseService` C++ 骨架（Activate/Deactivate/Validate 骨架函数返回 mock）
- [ ] 接入 `OSCrypt` 完成加密 round trip 测试
- [ ] `LicenseService` 实接 Creem dev test key（验证端到端调通）
- [ ] gtest 覆盖：手动重写 Shieldly `tests/license.test.ts` 场景
- [ ] mojom 接口定义 LicenseInfo / LicenseTier
- [ ] WebUI hello 页 + License 页 跳起交互，调起 mojom

### SDK 包（Phase 0 ~ M3）——面向外部开发者
- [ ] 创建 `packages/sdk-typescript/` 包
- [ ] 迁入 `crypto.ts`（去 chrome.storage.local 依赖）
- [ ] 提供 LicenseInfo TS 类型（从 mojom 生成或手写同步）
- [ ] 迁入 crypto.test.ts 作为 SDK 侧测试参考
- [ ] 发布 `@mosaiq/sdk` v0.0.1 到 npm （允许为空壳）

### i18n（M2 ~ M3）
- [ ] 写 `tools/i18n/convert-mv3-to-grd.ts` 转换脚本
- [ ] 转换后生成 `mosaiq_strings.grd` + `mosaiq_strings_zh-CN.xtb`
- [ ] WebUI 面板中调通 `loadTimeData.getString()`

### UI 组件（M5+）
- [ ] 建立 `chrome/browser/resources/mosaiq/components/` 骨架
- [ ] 拷入 Tailwind 配置（Chromium WebUI 多以原生 CSS 为主，需评估是否在 WebUI 环境引 Tailwind。备选：改用 CSS 变量 + tokens）
- [ ] 拷入 Toast / Tooltip / Toggle / Badge 设计（代码重写为 Chromium WebUI 兼容风格）

### 不要做的
- [x] **不要**移植 `identity-generator.ts`
- [x] **不要**移植 `trackers.generated.ts`
- [x] **不要**移植 `injectFingerprintSpoofing`
- [x] **不要**移植 `SiteRule` 模型
- [x] **不要**复用 Shieldly Creem 产品 ID
- [x] **不要**自动迁移 Shieldly 用户数据

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 复用代码导致 Shieldly bug 传染 Mosaiq | 移植时强制 100% 单元测试覆盖；新写测试用例 |
| 迁移后 Shieldly 无人维护 | Phase 0 不动 Shieldly；M3+ 决策是否同步升级 |
| Shieldly 用户混淆两个产品 | UI 完全独立；Mosaiq 不贴 "Shieldly Pro" 标签 |
| Creem 账户互相影响 | 完全独立 Creem 账户，分开计费 |
| 版权归属在融资时被审计 | Phase 0 法务时明确创始人 IP 转让协议 |

---

**最近更新**：T+0  
**下次审视**：M2（核心存储层移植完成时）
