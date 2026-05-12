# Patch 0011 — TLS / JA4 Spoof

**Phase**: A.4  **优先级**: P0（卖点核心）  **难度**: ⭐⭐⭐⭐⭐  **预期工时**: 6-12 周  
**依赖**: Patch 0014 Persona Bridge + Patch 0001 Canvas Noise（验证流水线先跑通）

## 目标

让 mosaiq-chromium 在 TLS handshake 阶段产出的 ClientHello 与目标 OS+Chrome 版本（如 "Chrome 130 on Windows 10"）字节级别一致，使 [tls.peet.ws](https://tls.peet.ws) / [browserleaks.com/tls](https://browserleaks.com/tls) / Scrapfly JA4 检测器报告的 JA4 / JA4_q / JA4_h2 hash = 目标 Chrome 真机的 hash。

## 为什么这是最难的 patch

1. **BoringSSL ≠ OpenSSL**：BoringSSL 是 Google fork 的 SSL 库，API / 内部结构与 OpenSSL 不一致，公开文档极少
2. **TLS 1.3 + QUIC 双栈**：仅改 TLS 不改 QUIC → HTTP/3 站点立刻识别（JA4_q 暴露）
3. **GREASE 占位**：Chrome 的 GREASE 值是确定的（`0x?A?A` 模式），但位置随机；要 deterministic per-persona
4. **ALPN 协商顺序**：很多人忽略，但是 JA4 的 final hash 一部分
5. **multi-record handshake**：fragment 大小也是 fingerprint 一部分

## 触点文件（待 A.4 时确认精确行号）

```
# BoringSSL（Chromium 的 fork）
third_party/boringssl/src/ssl/extensions.cc       # ext 顺序 + GREASE 占位
third_party/boringssl/src/ssl/handshake_client.c  # ClientHello 组装主入口
third_party/boringssl/src/ssl/ssl_lib.cc          # SSL_CTX_set_cipher_list 调用点

# Chromium net/ 层
net/socket/ssl_client_socket_impl.cc              # Configure SSL ctx 主入口
net/ssl/ssl_config.cc                             # SSLConfig 默认值
net/ssl/ssl_config_service.cc                     # 全局配置

# QUIC（HTTP/3）
net/third_party/quiche/src/quiche/quic/core/tls_handshaker.cc
net/third_party/quiche/src/quiche/quic/core/crypto/transport_parameters.cc
```

## 实现路径（最稳健的顺序）

### Step 1: 冻 BoringSSL commit
切到一个稳定 BoringSSL commit hash（避免上游漂移），写到 `DEPS` 文件锁定。

### Step 2: JA4 fingerprint 解构
解析目标 Chrome 130 win 真机抓包的 ClientHello，拆成：
- `cipher_suites`（17 个 cipher 的具体顺序）
- `extensions`（GREASE + 18 个 ext 的具体顺序）
- `signature_algorithms`（13 个 sigalg 顺序）
- `supported_groups`（4 个曲线 + GREASE 顺序）
- `key_share`（X25519 + secp256r1 顺序）
- ALPN（h2 / http/1.1 顺序）

输出：`tls_fingerprint_targets.json`，按 OS+Chrome 版本组织目标 fingerprint。

### Step 3: Patch BoringSSL extension order
修改 `extensions.cc`：从 `PersonaProfile.ja4_target` 读取目标 ext order，rewrite `tls_extension t kExtensions[]` 数组顺序。

GREASE 占位逻辑：
```c
// 当前 BoringSSL 是用 ssl->ctx->grease_seed 决定 GREASE 值
// 改成从 PersonaProfile 拿一个稳定 seed，让 GREASE per-persona deterministic
uint16_t grease_value = mosaiq_persona_grease(ssl, kIndex);
```

### Step 4: Patch cipher 顺序
`net/ssl/ssl_config.cc` 默认 cipher list 顺序由 Chromium 决定。改成：
```cpp
SSLConfig SSLConfigService::GetSSLConfig() {
  SSLConfig cfg;
  cfg.cipher_list_override = MosaiqPersona::Current()->ja4_target.cipher_list;
  return cfg;
}
```

### Step 5: Patch QUIC 同步
QUIC ClientHello 通过 TLS 1.3 inner handshake 包装，但有自己的 transport_parameters 顺序。修改 `tls_handshaker.cc` 让其参数顺序也 persona 绑定。

### Step 6: Patch ALPN
`SSL_CTX_set_alpn_protos` 调用前重排 protos buffer：
```cpp
std::vector<uint8_t> alpn = mosaiq_alpn_protos(persona);
SSL_CTX_set_alpn_protos(ctx, alpn.data(), alpn.size());
```

## 测试套件

### 单元测试
- gtest：mosaiq_persona_grease() 输出确定性
- gtest：alpn_protos() 顺序匹配 persona
- BoringSSL 自带的 `ssl_test`：确保改后所有 vanilla 测试还过

### 集成测试（browser_test + Wireshark）
- 启动 mosaiq-chromium 访问 https://tls.peet.ws，断言返回 JSON 里 `ja4` 字段 = 目标值
- 启动后 tcpdump 抓 ClientHello，对比真 Chrome 130 win 抓包，做 byte-level diff

### 检测站回归
| 站点 | 期望 |
|---|---|
| tls.peet.ws | JA4 = 目标 |
| browserleaks.com/tls | JA3 / JA4 / JA4_q / JA4_h2 全匹配 |
| Scrapfly JA4 detector | 显示 "Chrome 130 on Windows 10" |
| Cloudflare bot detection | botscore 不识别为 "automation" |

## Done condition

1. 用 3 个不同 persona（每个绑定不同 ja4_target）启动 → tls.peet.ws 返回 3 个不同 JA4
2. 同 persona 5 次启动 → 5 次 JA4 完全一致
3. JA4_q（QUIC）也匹配 → 访问任意 HTTP/3 网站不暴露
4. byte-level packet diff 与真 Chrome 130 win 一致

## 风险与陷阱

1. **BoringSSL upstream 升级会撕碎 patch**：每次 sync upstream 至少 2-4 周 rebase
2. **ChaCha20 vs AES-GCM cipher 优先**：服务器端选 cipher 时会影响 JA4 输出，要确保我们 client offer 的顺序 = 真 Chrome
3. **post-quantum cipher** (Kyber/X25519MLKEM768)：Chrome 121+ 默认开启，JA4 会包含它，要同步加进 spoof list
4. **TLS 1.2 fallback**：极少站点不支持 1.3 → fallback 到 1.2 时 JA3 又是另一套，也要 spoof
5. **HTTP/2 SETTINGS 帧**：JA4_h2 依赖此，但 SETTINGS 帧顺序在 patch 0012 范围 → A.4 不做完整 H2 fingerprint

## 参考

- `docs/CHROMIUM-FORK-GUIDE.md` §3 Patch 0011
- [JA4 spec by FoxIO](https://github.com/FoxIO-LLC/ja4)
- [tls.peet.ws source](https://github.com/wwhtrbbtt/TrackMeNot-Servers)
- [Chrome's GREASE behavior](https://datatracker.ietf.org/doc/html/rfc8701)
- [utls (Go)](https://github.com/refraction-networking/utls) 实现可借鉴 ClientHello 模板设计
- BoringSSL 源码：`third_party/boringssl/src/ssl/extensions.cc`
