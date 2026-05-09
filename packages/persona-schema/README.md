# @mosaiq/persona-schema

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

- `@mosaiq/sdk` — 浏览器启动与 CDP 注入
- `@mosaiq/desktop` — 桌面 GUI
- `@mosaiq/cli` — 命令行
- 未来 Chromium fork — C++ `PersonaService`（通过 JSON Schema 导出跨语言）

## 使用

### 从模板创建 Persona

```ts
import { createWin11ChromeUsPersona } from '@mosaiq/persona-schema/templates';

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
import { parsePersona, safeParsePersona } from '@mosaiq/persona-schema';

const persona = parsePersona(jsonData); // throws on invalid
const result = safeParsePersona(jsonData); // safe variant
```

### 导出 JSON Schema（供 Rust / C++ 消费）

```ts
import { getPersonaJsonSchema } from '@mosaiq/persona-schema';

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

License: Apache-2.0
