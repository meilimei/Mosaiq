/**
 * @mosaiq/persona-schema
 * Canonical Persona schema — 反检测浏览器身份的数据契约。
 *
 * 被以下组件消费：
 *   - @mosaiq/sdk          浏览器启动与注入
 *   - @mosaiq/desktop      桌面 GUI
 *   - @mosaiq/cli          命令行
 *   - @mosaiq/mcp-server   Agent 集成
 *   - chromium-fork        未来 C++ PersonaService
 */

export * from './persona.js';
export * from './system.js';
export * from './browser.js';
export * from './hardware.js';
export * from './fingerprint.js';
export * from './network.js';
export { randomNoiseSeed, deriveSeed, mulberry32, seedToUint32 } from './utils/seed.js';
export { getPersonaJsonSchema } from './utils/json-schema.js';
