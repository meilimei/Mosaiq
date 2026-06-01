/**
 * SDK 版本号。手工维护，与 `package.json` 同步——`version.test.ts` 在 CI 校验
 * 两者一致；漂移会 fail test，发版前必修。
 *
 * 没用 `import pkg from '../package.json'` 是因为：
 *   - `tsconfig` 默认 `resolveJsonModule:false`（开了会污染 dist 目录结构）
 *   - Node ESM 的 import assertion 在 Node 20.10 之前需要 `--experimental-json-modules`
 *   - 写入 dist 后 package.json 路径相对位置变（dist/package.json 不存在）
 *
 * 暴露这个常量的初始动机：Phase 8.5 desktop main 写 `DetectionRun.meta.sdkVersion`
 * 时需要带上 SDK 版本，但 electron `app.getVersion()` 返回的是 desktop app 版本，
 * 二者不一定同步。
 */
export const SDK_VERSION = '0.10.1';
