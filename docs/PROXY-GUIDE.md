# 住宅代理选购与配置指南

> Mosaiq v0.1 / 2026-05 整理。本文档为内部工程参考，价格与服务商信息会随市场变化，**使用前先去官网核实当下报价**。

---

## TL;DR：决策矩阵

| 你的场景 | 推荐 | 起付门槛 | 单价（GB） |
|---|---|---|---|
| 个人自用，< 20 persona，每月 1-5GB | **IPRoyal Residential（Pay-As-You-Go）** | $8 | $7 |
| 小团队，20-100 persona，每月 8-25GB | **Decodo（前 Smartproxy）月套餐** | $40 | $4-5 |
| 中型，100-500 persona，每月 50-200GB | **Soax** 或 **Decodo Pro** | $99 | $3-4 |
| 企业，> 500 persona | **BrightData / Oxylabs** 企业 SLA | $300-500/月 | $4-8（含 SLA） |

**v0.1 默认推荐：IPRoyal**。起付低、按量付费、无沉没成本，适合刚开始建账号矩阵。等用量稳定再升级到月套餐拿更低单价。

---

## 1. 为什么住宅代理是反检测刚需

| 代理类型 | 来源 | 反检测站标记率 | 适用 |
|---|---|---|---|
| 数据中心（DC） | AWS / DigitalOcean / 自建 VPS | **99% 拉黑** | 仅适合 API 抓取，不适合养号 |
| VPN（NordVPN/ExpressVPN） | 服务商共享 IP 池 | 95% 已标 VPN | 隐私可，反检测不可 |
| 移动 4G/5G | SIM 卡运营商 | 5%（最干净） | 极贵（$50-100/GB） |
| **住宅（Residential）** | 真实 ISP 家庭用户 IP | 10-20% | **反检测主流选择** |
| ISP 静态住宅 | 数据中心买的住宅 ASN | 30-50% | 介于 DC 和 RES 之间 |

**核心逻辑**：住宅 IP 的 ASN（自治系统号）属于 Comcast / Verizon / BT / Vodafone 等真实运营商，反检测站无法仅凭 IP 判断异常。但如果同一住宅 IP 短时间被多个账号登录 → 仍会被关联。所以 **sticky session + 每 persona 独立 session ID** 才是真正的关键。

---

## 2. 关键参数

### 2.1 Sticky Session（粘性会话）⭐⭐⭐

**最重要的概念**。同一个 persona 在一次会话内必须保持同一出口 IP，否则反检测站会发现「同 cookie 但 IP 来回跳」= 异常。

各家通过 username 或 password 后缀控制（⚠️ **IPRoyal 放 password**，其余几家放 username）：

| 服务商 | session 参数位置 | session 时长控制 |
|---|---|---|
| IPRoyal | **password 后缀**：`<password>_country-us_session-<random8>_lifetime-30m`（username 保持原样不动） | 后缀 `lifetime-Xm` |
| Decodo (Smartproxy) | username：`user-<user>-session-<random>-sessionduration-30` | 后缀 `sessionduration-X` |
| BrightData | username：`<user>-session-<random>` | 默认 1-30 分钟 |
| Soax | username：`<package_id>-session-<random>` | 5-30 分钟 |

**Mosaiq 集成**：把带后缀的完整字符串填进对应字段（IPRoyal 填 **password**，其余几家填 username），Mosaiq 会原样传给代理服务。`label` 字段建议写成 `iproyal-us-california-aliceabc-30m` 便于审计。

### 2.2 Country / Region Targeting

| 场景 | 配置 |
|---|---|
| Reddit US 账号 | US 住宅 IP + 时区 `America/New_York` 或 `America/Los_Angeles` |
| Twitter 国际账号 | 与目标受众地理一致（建议 US） |
| 跨境电商（速卖通买家） | 目标客户国家 IP |
| 真实地理隐藏 | 与你想伪装成的国家一致 |

**严重忌讳**：US IP 配 `Asia/Tokyo` 时区 → BrowserScan / Pixelscan 立刻标红。Mosaiq 在「测试代理」时会自动检测并 amber 警告。

### 2.3 协议

| 协议 | 推荐度 | 说明 |
|---|---|---|
| HTTP | ⭐⭐⭐ | 默认选这个。CONNECT 隧道，DNS 走代理（不会泄漏 DNS） |
| HTTPS | ⭐⭐ | 与 HTTP 类似，但代理与你之间多一层 TLS。多数场景没必要 |
| SOCKS5 | ⭐⭐ | 更底层但配置复杂，部分服务商支持 UDP，多数 web 场景用 HTTP 即可 |

---

## 3. 主流服务商对比（2026-05 公开报价）

### 3.1 IPRoyal Residential ⭐ v0.1 首推

- **官网**：https://iproyal.com/residential-proxies/
- **池规模**：32M+ IPs，195 国
- **endpoint**：`geo.iproyal.com:12321`（旧文档里的 `residential.iproyal.com` 已停用，以 dashboard 的 CONNECTION 面板为准）
- **计价**：纯按量（GB）
  - 默认 $7/GB
  - 50GB+ $4.5/GB
  - 500GB+ $1.75/GB
- **起付**：$8（≈ 1GB），充值制
- **Sticky**：**password 后缀**，`lifetime-1m` 到 `lifetime-30m`
- **优点**：
  - 个人友好，起付最低
  - 充值不限期不过期
  - Dashboard 简洁，KYC 宽松
- **缺点**：
  - 池规模小于 BrightData
  - 部分 ASN（如 Verizon US）高峰期慢
  - 客服一般（邮件 24-48h 回）
- **适合**：自用 / 测试 / 小工作室

### 3.2 Decodo（前 Smartproxy）

- **官网**：https://decodo.com/（旧域名 smartproxy.com 仍可用并自动跳转）
- **品牌变更**：Smartproxy 2024 年下半年品牌重塑为 Decodo
- **池规模**：65M+ IPs
- **endpoint**：`gate.decodo.com:7000`（旧 `gate.smartproxy.com:7000` 仍工作）
- **计价**：月套餐 + 按量两种
  - Starter 8GB / $40/月（$5/GB）
  - Regular 25GB / $100/月（$4/GB）
  - Pay-As-You-Go $7/GB
- **起付**：$40/月套餐，或 $7 PAYG
- **Sticky**：1-30 分钟
- **优点**：
  - Dashboard 一流，统计详细
  - API / 文档质量高
  - US / EU 池稳定
- **缺点**：
  - 月套餐用不完作废
  - 套餐外溢出价更高
- **适合**：小团队，用量可预估

### 3.3 BrightData（前 Luminati）

- **官网**：https://brightdata.com/
- **池规模**：72M+ IPs（行业最大）
- **计价**：阶梯
  - Pay-As-You-Go $8.40/GB
  - $500/月起 $5.88/GB
  - 大客户协商
- **起付**：$500/月（实际门槛）
- **Sticky**：1-60 分钟
- **优点**：
  - 池最大，长尾国家覆盖最全
  - 企业级 SLA + 24/7 客服
  - Web Unlocker 等增值服务
- **缺点**：
  - **KYC 严**：要求公司主体 / 用途说明，会拒绝个人用户
  - 起付高
  - Dashboard 复杂（陡峭学习曲线）
- **适合**：企业 / 大规模合规场景

### 3.4 Oxylabs

- **官网**：https://oxylabs.io/
- **池规模**：100M+ IPs
- **计价**：$8/GB 起，$300/月起付
- **优点**：池大，速度稳，企业向
- **缺点**：与 BrightData 类似，KYC 严
- **适合**：企业

### 3.5 Soax

- **官网**：https://soax.com/
- **计价**：$99/月起（IP-port 数 + GB 混合计价）
- **池规模**：155M+ IPs（声称）
- **优点**：地理粒度细到城市
- **缺点**：定价复杂，需细看
- **适合**：需要城市级定向的中型用户

### 3.6 价格对比（按 50GB 月用量计）

| 服务商 | 月支出 | 单价 | 起付 |
|---|---|---|---|
| IPRoyal PAYG | $225 (50×$4.5) | $4.5/GB | $8 |
| Decodo 月套餐 | $200 (50GB 套餐) | $4/GB | $40 |
| Soax | $250 起 | $5/GB | $99 |
| BrightData | $295 (50×$5.88) | $5.88/GB | $500 |
| Oxylabs | ~$350 | $7/GB | $300 |

50GB 这个量级 IPRoyal / Decodo 性价比相当，**起付 + 灵活性优势让 IPRoyal 成为 v0.1 首选**。

---

## 4. v0.1 完整购买与配置流程（IPRoyal 为例）

### 4.1 购买

1. 访问 https://iproyal.com/residential-proxies/
2. 注册账号（邮箱即可，无需公司）
3. 进 Dashboard → "Residential Proxies" → "Buy GB"
4. 充值 $8（= 1GB 起步，足够测试 5-10 个 persona 一周）
5. Dashboard 的 **CONNECTION** 面板显示：
   - **Proxy hostname**: `geo.iproyal.com`
   - **Proxy port**: `12321`
   - **Proxy username**: `<your_username>`（形如 `abc123def456`，**保持原样，不加后缀**）
   - **Proxy password**: `<your_password>`（geo 定向 / session / lifetime 后缀都加在**这里**）

### 4.2 sticky session 命名约定

每个 persona 一个独立 session ID。**绝对不能**多个 persona 共用同一 password 后缀（= 同 IP = 关联）。
⚠️ IPRoyal 把 country / state / session / lifetime 全部加在 **password** 上，username 不动。

```
模板（加在 password 上）：<base_password>_country-us[_state-<州>]_session-<8位随机>_lifetime-<分钟>m

示例（username 都是 abc123def456，password 各不同）：
real-win11  → pwd_country-us_state-florida_session-aliceR4nd_lifetime-30m
real-macos  → pwd_country-us_state-california_session-bobX9z2k_lifetime-30m
real-ubuntu → pwd_country-us_state-virginia_session-caraQw7p_lifetime-30m
```

> `_state-<州>` 可选，但**强烈建议加**：不加的话 IPRoyal 在全美随机给 IP，出口时区会随 IP 漂移，和 persona 固定时区对不上（BrowserScan/Pixelscan 标红）。加州=Pacific、佛州/佐治亚/弗吉尼亚=Eastern。州名用单词小写（多词如 `new_york` 用下划线）。
> ⚠️ 改了 state 但复用旧 session ID 可能 `ECONNRESET`（旧 session 已绑旧 IP）——换个新 session ID 即可。

session ID 推荐 8-12 字符随机，避免规律性（不要用 `01/02/03`，反检测可能 fingerprint）。

`lifetime-30m` 是 sweet spot：
- < 5m：IP 频繁切换，反检测会记录「同 cookie + 多 IP」= 异常
- 30m：覆盖一次正常浏览会话
- > 60m：IP 老化，可能进入风控池

### 4.3 在 Mosaiq Desktop 配置

1. 启动 Mosaiq Desktop（`pnpm dev:desktop`）
2. 列表页 → ➕ 新建 / ✏️ 编辑 / 📋 克隆 → 进入表单
3. 「代理」区勾选 ☑ 启用
4. 填入：

| 字段 | 值 |
|---|---|
| 协议 | HTTP |
| 标签 | `iproyal-us-california-aliceR4nd-30m` |
| 主机 | `geo.iproyal.com` |
| 端口 | `12321` |
| 用户名 | `<base_username>`（原样，**不加后缀**） |
| 密码 | `<your_password>_country-us_state-california_session-aliceR4nd_lifetime-30m` |

> CLI 等价写法：`mosaiq personas update <id> --proxy "http://<username>:<password>_country-us_state-california_session-aliceR4nd_lifetime-30m@geo.iproyal.com:12321"`。

5. 点击「测试代理」按钮
6. 确认结果面板：
   - ✓ 出口 IP（每次 session 重启会变，但 30m 内稳定）
   - ✓ 国家 / 城市（应该是 US）
   - ✓ 时区（应是 `America/*`）
   - ✓ ISP（应是 Comcast / Verizon / Spectrum / AT&T 等真实 ISP）
7. 时区不一致警告 → 点「一键应用 <代理时区>」让 Mosaiq persona 时区跟代理对齐
8. 保存 persona → 启动浏览器 → 自检（自动开 BrowserScan 等检测站）

### 4.4 自检验证

启动后浏览器会自动打开 detection lab。验证：

- ✅ `https://api.ipify.org`：显示代理出口 IP（不是你本机 IP）
- ✅ `https://browserscan.net`：IP 不应被标 "blacklisted"
- ✅ `https://pixelscan.net`：IP 与时区 / 语言一致
- ⚠️ WebRTC IP 泄漏检查：Mosaiq 默认 `webrtc.mode = 'proxy_only'` 应该只暴露代理 IP，不暴露真实本机 IP

---

## 5. 流量预估

| 行为 | 单次流量 |
|---|---|
| Reddit 浏览 30min | 50-200 MB（含图片视频） |
| Twitter 浏览 30min | 80-300 MB |
| Facebook 浏览 30min | 100-400 MB |
| 仅 API 操作（无图） | 1-5 MB |
| 加载一个 SaaS Dashboard | 5-20 MB |
| 提交表单 / 发帖 | 1-10 MB |

**估算**：v0.1 自用，5 个 persona × 每个每天 1-2 次会话 × 100 MB ≈ 0.5-1 GB / 天 ≈ 15-30 GB / 月

→ IPRoyal 50GB 阶梯（$4.5/GB） $135-225/月，或先 PAYG $7/GB $100-200/月。

---

## 6. 时区一致性（Mosaiq 已自动校验）

代理出口 IP 的地理时区**必须**与 persona 的 `system.timezone` 一致。

| 代理出口 | persona 时区 |
|---|---|
| US 东海岸 (NYC) | `America/New_York` |
| US 西海岸 (LA) | `America/Los_Angeles` |
| US 中部 (Chicago) | `America/Chicago` |
| UK | `Europe/London` |
| 德国 / 法国 | `Europe/Berlin` / `Europe/Paris` |
| 日本 | `Asia/Tokyo` |

**Mosaiq 自动化**：

- 「测试代理」会调 `ipinfo.io` 拿代理出口的 `timezone` 字段
- 与 persona 当前时区比对
- 不一致 → amber 警告 + 「一键应用 <代理时区>」按钮
- 编辑 / 克隆 / 创建三个表单都接入此校验

---

## 7. 红色警示清单 ❌

| 错误做法 | 后果 |
|---|---|
| 多个 persona 共用同一 username（无 session 后缀） | 同 IP → 反检测站立即关联多个账号 |
| 数据中心代理（AWS / Vultr / 自建 VPS） | 99% 反检测站直接拉黑 |
| 免费住宅代理（GitHub 找的 list） | 已被各大平台 fingerprint，IP 几乎全在黑名单 |
| 共享 VPN（NordVPN / ExpressVPN） | IP 被标记 "VPN provider"，反检测高分 |
| 时区与代理国家不一致 | BrowserScan / Pixelscan 立刻标红 |
| sticky lifetime > 60min | IP 老化，可能进入平台风控池 |
| 用未付费的「试用代理」长期养号 | 试用期 IP 进入低质量池，被标记 |

---

## 8. 进阶：多 persona 矩阵的代理策略

### 8.1 矩阵规模 vs 单 persona 月用量

| persona 数 | 单 persona 月用量 | 总月用量 | 推荐档 |
|---|---|---|---|
| 1-5 | 5GB | 5-25GB | IPRoyal PAYG |
| 5-20 | 3GB | 15-60GB | IPRoyal 50GB 档 / Decodo 25GB 套餐 |
| 20-100 | 2GB | 40-200GB | Decodo Pro / Soax |
| 100+ | 1-2GB | 100-500GB+ | BrightData 企业合同 |

### 8.2 跨服务商分散风险

**反建议**：把所有 persona 都用同一服务商。

理由：
- 一旦该服务商 IP 池被某个反检测站新规则标记，你所有账号同时遭殃
- 服务商被 DDoS / 倒闭 = 你的整个矩阵失效

**好做法**：
- 50% IPRoyal + 50% Decodo
- 或 80% 主供应商 + 20% 备用（可快速切换）

### 8.3 sticky 时长分层

不同活跃度 persona 用不同 lifetime：

| persona 活跃度 | lifetime |
|---|---|
| 重度（每天数小时） | 30m（一次浏览会话） |
| 中度（每周几次） | 10-15m（每次任务足够） |
| 低度（每月登录） | 1-5m（每次都换 IP，模拟「家里换路由器」） |

---

## 9. FAQ

**Q：买多少 GB 合适？**
A：v0.1 测试 1-5 GB 起步。先看实际用量再续。IPRoyal 不限期，余额可以一直用。

**Q：可以一个代理给多个 persona 用吗？**
A：可以，**但每个 persona 必须用不同的 sticky session ID**。base_username 相同没关系，关键是 `_session-XXX` 后缀不同 → 出口 IP 不同。

**Q：代理速度太慢怎么办？**
A：1) 换出口 region；2) 缩短 sticky lifetime（IP 池轮换更快）；3) 升级到大池服务商（BrightData / Oxylabs）。

**Q：怎么检测代理是否被封？**
A：在 Mosaiq 启动浏览器后开 `https://browserscan.net` 或 `https://pixelscan.net`，看 IP 是否被标 "blacklisted"、"datacenter"、"hosting"。被标了立刻换 session ID 拿新 IP。

**Q：代理用户名密码怎么安全存储？**
A：v0.1 当前是明文存在 `~/.mosaiq/personas/<id>.json`。v0.2 计划接入 OS keychain（Windows Credential Manager / macOS Keychain / libsecret），到时密码字段会自动加密。

**Q：会扣费很多吗？**
A：每个 ipinfo.io 测试请求 < 1 KB，1GB 套餐够测试几十万次。不必担心测试代理这个动作。

**Q：BrightData 拒绝个人用户怎么办？**
A：直接用 IPRoyal / Decodo。BrightData 的核心优势是池子大 + SLA，对 v0.1 自用没必要。

**Q：能不能用免费代理跑测试？**
A：技术上可以验证 Mosaiq 代理流程是否正常工作，但**不要用免费代理实际养号**。免费代理 IP 几乎全部已被反检测识别为高风险。

---

## 10. 服务商联系与折扣（持续更新）

| 服务商 | 联系 | 折扣 |
|---|---|---|
| IPRoyal | support@iproyal.com | 偶尔有 10-15% off 优惠码（搜 reddit r/proxy） |
| Decodo | hi@decodo.com | 有学生 / 创业者计划 |
| BrightData | sales@brightdata.com（要 demo） | 大客户协商 |

> 待补：实际购买时尝试和销售要 first-month 折扣。

---

## 11. Mosaiq 内置代理工具速查

| 功能 | 位置 | 说明 |
|---|---|---|
| 代理预检 | Create / Edit / Clone 表单 | 通过代理拉一次 ipinfo.io，验证可用性 |
| 时区一致性检测 | 同上 | 代理出口时区与 persona 时区不一致时 amber 警告 |
| 一键应用代理时区 | 同上 | 自动把 persona 时区设为代理出口时区 |
| sticky session 标签 | persona.network.proxy.label | 自由文本，便于审计/调试 |
| Detection Lab 自动开启 | 列表页「自检」按钮 | 启动浏览器并自动打开 BrowserScan / Pixelscan |

代理验证 SDK 入口：`@runova/sdk` 的 `verifyProxy(config)` 函数（`packages/sdk/src/proxy.ts`）。

---

## 12. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-05-09 | 初稿，基于 v0.1 状态整理 |
| 2026-06-06 | 修正 IPRoyal 实测发现的两处错误：endpoint 应为 `geo.iproyal.com:12321`（`residential.iproyal.com` 已停用）；country/state/session/lifetime 后缀加在 **password** 而非 username。补充 `_state-<州>` 定向（保证出口时区稳定）与「改 state 复用旧 session 致 ECONNRESET」排查。 |

---

**最后更新**：2026-06-06  
**适用版本**：Mosaiq v0.1.0（IPRoyal 接入实测校正）  
**文档作者**：内部参考（自用养号场景为主）
