# @runova/persona-schema

Canonical Persona schema — Mosaiq 反检测浏览器身份的数据契约。

## 定位

一个 **Persona** = 一个完整的浏览器身份。涵盖：

- **System**：OS family / 版本 / 架构、locale、timezone、屏幕几何
- **Browser**：品牌、版本、User-Agent、UA Client Hints
- **Hardware**：CPU 核数、设备内存、GPU vendor/renderer、音频 sampleRate
- **Fingerprint**：Canvas/WebGL/Audio 噪声种子、字体白名单、WebRTC 策略
- **Network**：代理配置
- **Metadata**：ID、显示名、标签、时间戳

这份 schema 被以下组件消费：

- `@runova/sdk` — 浏览器启动与 CDP 注入
- `@mosaiq/desktop` — 桌面 GUI
- `@mosaiq/cli` — 命令行
- 未来 Chromium fork — C++ `PersonaService`（通过 JSON Schema 导出跨语言）

## 使用

### 从模板创建 Persona

```ts
import { createWin11ChromeUsPersona } from '@runova/persona-schema/templates';

const alice = createWin11ChromeUsPersona({
  id: 'reddit-alice',
  displayName: 'Reddit Alice',
  tags: ['reddit', 'us', 'warming'],
  timezone: 'America/New_York',
  proxy: {
    protocol: 'http',
    host: 'residential.iproyal.com',
    port: 12321,
    username: 'user-sess-abc123',
    password: 'secret',
    label: 'iproyal-us-sticky',
  },
});
```

### 校验

```ts
import { parsePersona, safeParsePersona } from '@runova/persona-schema';

const persona = parsePersona(jsonData); // throws on invalid
const result = safeParsePersona(jsonData); // safe variant
```

### 导出 JSON Schema（供 Rust / C++ 消费）

```ts
import { getPersonaJsonSchema } from '@runova/persona-schema';

writeFileSync('persona.schema.json', JSON.stringify(getPersonaJsonSchema(), null, 2));
```

## 演化规则

- 字段只增不删，老 persona 文件永远可读
- 新增字段必须 optional 或有默认值
- Breaking change 必须升 `PERSONA_SCHEMA_VERSION`

## 反检测设计备注

- **Noise seed 确定派生**：master seed → `deriveSeed(master, 'canvas')` → 同一 persona 多次启动指纹一致
- **Font list 与 OS 自洽**：Windows persona 不应有 `San Francisco`
- **Timezone 必须 IANA**：拒绝 `EST` 等缩写
- **Locale 必须 BCP 47**：`en-US` 而非 `EN_US`
- **WebRTC 默认 proxy_only**：避免代理场景下本地 IP 泄露

## WebGL profile 选择（v0.3+）

`hardware.gpu.webglProfileId` 字段（可选）允许用户显式指定 SDK 内置 WebGL
profile 来覆盖基于 `webglRenderer` 字符串的 regex 自动选择。

```ts
const persona = createWin11ChromeUsPersona({ id: 'x', displayName: 'X' });
persona.hardware.gpu.webglProfileId = 'intel-uhd-630-d3d11'; // override
```

当前 SDK 提供 2 个内置 profile：

| profile id | 匹配 renderer | 适用模板 |
|---|---|---|
| `intel-uhd-730-d3d11` | `/UHD Graphics 730/` | `win11-chrome-us` |
| `intel-uhd-630-d3d11` | `/UHD Graphics 630\b/` | `win10-chrome-us` |

如果 `webglProfileId` typo / 未注册，SDK 会自动降级到 regex 匹配（避免 typo
关闭 spoof）。

### CreepJS WebGL bold-fail 预期

**已知 limitation**：所有 4 个内置 persona 模板在 [creepjs.com](https://creepjs.com)
上预期会触发 `LowerEntropy.WEBGL` bold-fail。

**为什么**：CreepJS 用硬编码白名单（`capabilities[]` 237 个 int hash +
`brandCapabilities[]` 287 个 hex hashMini）检测 GPU 真伪。新 GPU（如 UHD
730 Alder Lake 2022+）或非典型 driver 版本的真实硬件用户**同样会被误判**。

**这不是 Mosaiq spoof 缺陷**。我们的 49-param WebGL profile 完整匹配 ANGLE
D3D11 backend 真实值；问题是 CreepJS 数据库覆盖有限。详细数学分析（包括
为何 blind reverse-fit 在数学上不可能）见 `packages/sdk/bench/PHASE-2-PLAN.md`
Phase 2.2 Part 2。

**实操影响**：

- creepjs.com WebGL 显示 `lies` / `not-trusted` —— 预期内
- 其他主流 fingerprinter（browserleaks / sannysoft / pixelscan）不依赖
  此白名单，pass rate 正常
- 真实硬件 + 主流 driver 版本的用户访问 creepjs 同样会触发 bold-fail，
  这是行业普遍现象

License: Apache-2.0
