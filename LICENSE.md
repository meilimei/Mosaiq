# Mosaiq 许可证策略

> 状态：草案，最终方案在公司主体注册完成后由法务确认。

## 一、整体原则

Mosaiq 采取 **"核心闭源 + 边缘开源"** 策略。

| 部分 | 许可证 | 仓库可见性 |
|---|---|---|
| **Chromium fork 主体（含 native UI views + WebUI 面板 资源）** | **GPL-2.0**（Chromium 强制传染，包括对 Chromium 本体的修改） | 公开（合规要求） |
| **Browser Process Services（C++）** — PersonaService / LicenseService / ProxyRouter / DetectionLab | 商业闭源（以独立 component 形式准入，不作为 Chromium fork 的一部分发表） | 私有 |
| **WebUI 面板 业务逻辑（React + TS）** | 商业闭源（编译后作为 `.grd` 资源嵌入主体二进制） | 私有 |
| **Persona Library（数据资产）** | 商业闭源 + 加密 | 私有 |
| **Detection Lab 检测策略** | 商业闭源 | 私有 |
| **Persona Schema（数据格式定义）** | Apache-2.0 | 公开 |
| **TypeScript SDK** | Apache-2.0 | 公开 |
| **Python SDK**（v1.0+） | Apache-2.0 | 公开 |
| **CLI 工具** | Apache-2.0 | 公开 |
| **MCP Server 适配** | Apache-2.0 | 公开 |
| **公开文档站** | CC BY 4.0 | 公开 |

## 二、为什么这样切

1. **Chromium 是 BSD/MIT，但其依赖（如部分 V8、Skia 模块、ffmpeg）含 LGPL/GPL**。一旦你修改并分发 Chromium fork，按惯例需要 **公开你对相应组件的修改**。AdsPower / GoLogin / Multilogin 都没真正满足这一点（业界灰色地带），但我们要做"最好"，建议合规——把 patch 集合公开，**不公开**调用 patch 的上层产品代码。

2. **Persona Schema 开源 + SDK 开源**：构建开发者生态，让爬虫 / 自动化社区把 Mosaiq 当成事实标准。竞品都没做这一点。

3. **Browser Process Services + WebUI 业务逻辑闭源**：保护商业模式与定价权。重要区别：
   - 对 Chromium 本体的 patch 必须 GPL-2.0 公开。
   - C++ Services 设计为独立 component，以 GN 的 `is_chrome_branded`-类似机制接入主构建，**不污染 GPL 边界**（该设计需于 Phase 0 法务 review 后最终锁定）。

## 三、第三方商标声明（占位）

- "Chromium" 是 The Chromium Project 商标
- "Chrome" 是 Google LLC 商标  
- "Multilogin" / "AdsPower" / "GoLogin" / "Dolphin{anty}" 是各自所有者商标
- Mosaiq 不与上述任何实体有从属或合作关系

## 四、用户协议要点（最终需法务起草）

- 用户须遵守目标平台的服务条款
- Mosaiq 不承担因违反目标平台 ToS 导致的封号责任  
- 禁止用于：欺诈、洗钱、儿童不当内容、政治操纵
- 数据本地化：付费用户的 profile 加密后可选云同步

## 五、待法务确认事项

- [ ] 公司主体注册地（PRD §11 已建议新加坡）
- [ ] 商标注册（同名 / 域名 / 商标在主要市场）
- [ ] 用户协议起草
- [ ] 隐私政策（GDPR / CCPA / PIPL 兼容）
- [ ] DPA（数据处理协议，企业客户必备）
- [ ] 内核工程师劳动合同中的"对开源的贡献义务"条款
