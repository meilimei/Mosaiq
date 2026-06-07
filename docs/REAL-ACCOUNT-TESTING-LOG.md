# 真账号实测记录（Real-Account Testing Log）

> **怎么用**：这是 [EVIDENCE-AND-VALIDATION.md §4](./EVIDENCE-AND-VALIDATION.md) 协议的**填写表**。
> 每跑一次（每天 / 每个 persona × 站点）就追加一行。**禁止伪造**——所有行必须来自真实操作。
> 被识破 / 被 challenge 的行，开 issue（[detection-report 模板](../.github/ISSUE_TEMPLATE/detection-report.yml)）后把 issue 链接填进「证据」列。
>
> 完整操作步骤见 [REAL-ACCOUNT-TESTING-RUNBOOK.md](./REAL-ACCOUNT-TESTING-RUNBOOK.md)。

---

## 本轮元信息

| 项 | 值 |
|---|---|
| 开始日期 | 2026-06-06 |
| SDK 版本 | `@runova/sdk` 0.10.1 |
| chromium 版本 | 147.0.7727.15（UA 声称 Chrome 147，启动时自动对齐真实版本） |
| 代理服务商 | IPRoyal Residential（`geo.iproyal.com:12321`，US 住宅，state 定向，sticky lifetime-30m） |
| 操作人 | __ |

四个模板 persona（已创建并绑独立住宅代理 + state 定向，proxy 全部验证通过）：

| persona-id | 模板 | 代理标签 | 用途 |
|---|---|---|---|
| `real-win11` | win11-chrome-us | iproyal-us-florida（Eastern） | Reddit / Cloudflare |
| `real-win10` | win10-chrome-us | iproyal-us-georgia（Eastern） | X / DataDome |
| `real-macos` | macos-sonoma-chrome-us | iproyal-us-california（Pacific） | Google |
| `real-ubuntu` | ubuntu-2204-chrome-us | iproyal-us-virginia（Eastern） | 交叉验证 |

---

## 结果记录

> `结果` 取值：`pass`（顺利通过/登录）/ `challenge`（出验证码/二次验证但能过）/ `block`（被拦/封号/无法继续）。
> `被识破 surface`：尽量具体到指纹面（webgl / canvas / navigator / tls / 行为 / IP / 其他），别只写「被封」。

| 日期 | persona | 目标站 | 路径 | 结果 | 被识破 surface | 证据 / issue 链接 |
|------|---------|--------|------|------|----------------|-------------------|
| 2026-06-06 | real-win11 | reddit.com/login（http 代理） | open-persona | block | 网络层：GFW 对明文 HTTP 代理的 CONNECT 注入 RST（ERR_CONNECTION_RESET）。改用 https/TLS 代理后解决 | — |
| 2026-06-06 | real-win11 | reddit.com/login（florida IP×2） | open-persona(https) | block | 出口 IP 信誉：Reddit "blocked by network security"，florida 两个 IP 均被边缘层拦（指纹层未触及） | — |
| 2026-06-06 | real-win11 | reddit.com 注册 | open-persona(https, georgia g2r8k3mp) | **pass** | 无：乔治亚干净 IP，**成功注册新账号**（过 GFW + IP 信誉 + 注册反机器人三层） | 新账号已建 |
| 2026-06-06 | real-ubuntu | datadome.co | open-persona(https, 弗吉尼亚, 换1次IP) | **pass** | 换干净 IP 后正常加载，DataDome 未判 bot → 指纹通过(同级商业 WAF 旁证) | 截图 |
| 2026-06-06 | real-ubuntu | nopecha cloudflare demo | open-persona(https, 多次换IP) | inconclusive | Turnstile 卡 "Verifying"，报 "can't reach challenges.cloudflare.com" → 挑战网络往返在"墙内+住宅代理双跳"高延迟下完不成；**链路层问题非指纹**(非 "blocked")。换多 IP 无效。需墙外低延迟环境复测 | 截图 |
| 2026-06-06 | real-win10 | x.com 注册 | open-persona(https, 乔治亚) | challenge | 登录页/注册流程/早期机器人检测均通过，卡在 X 新号强制手机验证(被拒) → X 账号政策层，非指纹层；无现成老号无法测登录 | 截图 |
| 2026-06-06 | real-macos | accounts.google.com 登录 | open-persona(https, 加州 m4k8p2nx) | **pass** | 无指纹拦截：仅触发账号自带 2-Step(手机 App 点允许+选数字)即成功登录，Google 未弹"浏览器不安全/异常活动" → 指纹层通过 | 已登录 |
| 2026-06-06 | real-macos | www.google.com 搜索 | open-persona(https, 加州 m4k8p2nx) | block | Google Search 对该住宅 IP 软拦（google.com/sorry 类，非测试目标，附记） | — |
| 2026-06-06 | real-ubuntu | detection-lab(12 站) | cli detection-lab(headless,https) | **pass** | 12/12 站加载，hits=1 low：仅 creepjs WebGL 白名单 miss（liesCount=0，非伪装失败）。无 webdriver/canvas/navigator 等真命中 | run 2026-06-07T04-31-55 |
| 2026-06-06 | real-win10 | detection-lab(12 站) | cli detection-lab(headless,https) | **pass** | 5/12 站加载（其余 fail=代理超时非检测），hits=1 low：同 creepjs WebGL 白名单 miss（liesCount=0） | run 2026-06-07T04-24-09 |
| 2026-06-06 | real-macos | detection-lab(12 站) | cli detection-lab(headless,https) | n/a | 0/12 加载（加州 m4k8p2nx IP 当时慢，全站超时）→ 网络层问题非检测结论；该 persona 锁定 Google 账号不动 IP，择机重跑 | run 2026-06-07T04-30-25 |

（继续往下加行。）

---

## 每日小结（可选，便于回看趋势）

### 2026-06-06（Day 1）
- 跑了哪些 persona × 站点：real-win11→Reddit；real-macos→Google(accounts)+google search；real-win10→X 注册；real-ubuntu/real-win10/real-macos→detection-lab 12 站。
- pass / challenge / block 计数：pass 4（Reddit 注册、Google 登录、ubuntu+win10 detection-lab）/ challenge 1（X 手机验证）/ block 2（Reddit 旧 IP×2、Google Search IP 软拦）。
- 新开的 detection-report issue：0（唯一指纹命中是 creepjs WebGL 白名单 miss，liesCount=0 非伪装失败，不予开 issue）。
- 观察 / 怀疑：
  1. **链路层是真瓶颈,非指纹**：墙内必须用 https/TLS 代理（明文 HTTP 代理的 CONNECT 域名被 GFW RST）；IPRoyal 住宅池部分 IP 被 Reddit/Google-Search 拉黑，需轮换找干净 IP。
  2. **指纹层表现强**：Reddit 注册 + Google 登录两个最严场景均过，CreepJS liesCount=0，无 webdriver/canvas/navigator 真命中。
  3. **加州 IP 池偏不稳**（ECONNRESET / detection-lab 全超时），东部州（georgia/virginia）稳得多。
  4. X 新注册卡手机验证=账号政策，非 Mosaiq 可解。
  5. **工程缺口**：browser-pod 不支持带认证的代理（persona-flags.ts 只传 host:port，丢 user/pass）→ 云端养号前置阻塞，已记待办。

### 2026-__-__（Day 2）
- …

---

## 一周收尾汇总

| 指标 | 数值 |
|---|---|
| 总测次数 | |
| pass | |
| challenge | |
| block | |
| 开的 detection-report issue 数 | |
| 最常被识破的 surface | |

**结论与下一步**（喂给 `packages/sdk/src/injection/runner.ts` 的修补优先级）：

-
