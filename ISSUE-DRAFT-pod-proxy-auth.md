## 摘要 / Summary

云端 `browser-pod` 启动 chromium 时只把代理的 `host:port` 传给 `--proxy-server`，**丢掉了 username/password**。因此**认证型代理**（住宅 / ISP，如 IPRoyal）在云端会话里用不了：要么代理返回 `407 Proxy Authentication Required` 导致页面打不开，要么回落到 Fly 数据中心出口 IP。

这与 desktop / SDK 路径**不对等**——后者能正常使用认证代理。

## 影响 / Impact

- **阻塞 GTM 事项 2（LaunchAI prod 云端养号）**：Reddit grooming 必须从干净住宅 IP 出网；当前云端无法用认证住宅代理 → 只能用 Fly 数据中心 IP → 账号必被风控。
- **阻塞 GTM 事项 3（外部 Stagehand / browser-use 用户）**：BYOP 住宅代理是这些用户的刚需。
- **违背产品承诺**：CLOUD-RUNTIME-ARCH「BYOP 默认开」+「改一行 baseURL 就能迁」的 Cloud 卖点，在认证代理下不成立。
- **实测佐证（2026-06-06）**：本地 desktop 用 IPRoyal 住宅代理成功完成 Reddit 注册 + Google 登录（见 `docs/REAL-ACCOUNT-TESTING-LOG.md`）。但这些账号**无法迁到云端养**——云端复刻不了同一个认证住宅出口 IP，账号一旦从 Fly 数据中心 IP 出现即触发风控。

## 根因 / Root cause

pod 直接 `spawn` chromium、手工拼 flag，只拼了 `--proxy-server`，而 chromium 的 `--proxy-server` **本身不携带认证**：

```ts
// apps/browser-pod/src/persona-flags.ts
if (persona.network.proxy) {
  const p = persona.network.proxy;
  const scheme = p.protocol === 'socks5' ? 'socks5' : p.protocol;
  flags.push(`--proxy-server=${scheme}://${p.host}:${p.port}`); // ← 丢了 p.username / p.password
}
```

对照 desktop / SDK 路径，凭据是带上的，由 Playwright 自动应答 407：

```ts
// packages/sdk/src/launcher.ts
launchOptions.proxy = toPlaywrightProxy(persona.network.proxy);

// packages/sdk/src/proxy.ts —— toPlaywrightProxy 带 username/password
return { server: buildProxyServerArg(proxy), bypass, username: proxy.username, password: proxy.password };
```

pod 侧也**没有任何**代理认证处理（已全仓搜：无 `Proxy-Authorization`、无 CDP `Fetch.authRequired` / `continueWithAuth`）。

## 复现 / Repro

1. 准备一个 `network.proxy` 指向**认证型住宅代理**的 persona（如 IPRoyal：`geo.iproyal.com:12321` + username/password，password 带 `_country-us_state-..._session-..._lifetime-30m`）。
2. 云端 `POST /v1/sessions`（persona inline 或 id）。
3. `connectOverCDP` 后 `page.goto('https://ipinfo.io/json')`。
4. **现象**：407 / 页面打不开 / 或出口 IP 是 Fly 数据中心而非代理出口。
5. **对照**：同一 persona 本地 `pnpm open-persona <id>` 正常出代理 IP（走 `toPlaywrightProxy`）。

## 修法 / Proposed fixes

### 方案 A（首选）：pod 内本地认证转发代理

- pod 内起一个轻量本地代理（监听 `127.0.0.1:<随机口>`），负责给上游请求注入 `Proxy-Authorization`，再转发到真正的上游代理（IPRoyal）。
- chromium 的 `--proxy-server` 指向这个本地口（无需认证）。
- **优点**：凭据只在 pod 内、不暴露给 chromium 命令行（避免 argv 泄漏）；对 chromium 完全透明；http / https / socks5 上游都能统一处理；与现有 `spawn` 架构兼容，改动局部。
- **要点**：本地代理随 session 生命周期起停；凭据从 `persona.network.proxy` 读、不落日志；HTTPS / SOCKS5 上游分别用对应的转发实现。

### 方案 B：pod / relay 侧用 CDP `Fetch.authRequired` 回填凭据

- 监听 chromium 的 proxy 认证质询，用 `Fetch.continueWithAuth` 应答。
- **缺点**：与 cdp relay 的时序 / 生命周期耦合较深；每次 navigation 都要保证 Fetch 域已启用；socks5 不走 HTTP 407，覆盖不全。

### 方案 C：pod 改用 Playwright `launchPersistentContext({ proxy: { server, username, password } })`

- 直接复用 SDK 同款逻辑（`toPlaywrightProxy`），认证由 Playwright 处理。
- **缺点**：放弃当前"直接 spawn chromium"带来的精细控制（pod 刻意 spawn 而非 Playwright，见 `persona-flags.ts` 头注释）；改动面最大。

> 倾向 **方案 A**：最小侵入、凭据最安全、协议覆盖最全，且不动 pod 的 spawn 模型。

## 验收标准 / Acceptance criteria

- [ ] 配置认证型住宅代理的 persona，云端会话**出口 IP == 代理出口 IP**（用 `ipinfo.io` / SDK `verifyProxy` 验证），**不是** Fly 数据中心 IP。
- [ ] `http` / `https` / `socks5` 三种上游协议都能完成认证。
- [ ] 代理凭据**不写日志、不超出会话生命周期落盘**（argv 也不暴露明文，方案 A 天然满足）。
- [ ] 新增 / 扩展一条 e2e 或 `prod-smoke` 断言："认证代理出口"路径通过（出口 IP 命中预期代理出口）。
- [ ] 其他行为不回归：`stealth.inject` 服务端注入、keepAlive/sticky、`webrtc.mode=proxy_only` 等照常。

## 关联 / Related

- GTM 人工清单 `docs/GTM-HUMAN-CHECKLIST.md` §4（LaunchAI prod 云端养号）、§5（外部用户 BYOP）。
- 实测日志 `docs/REAL-ACCOUNT-TESTING-LOG.md` Day 1 观察 #5（首次暴露此缺口）。
- 对比实现：`packages/sdk/src/proxy.ts` `toPlaywrightProxy` / `packages/sdk/src/launcher.ts`。
- 缺口位置：`apps/browser-pod/src/persona-flags.ts`（proxy flag 拼接处）。
