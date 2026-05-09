/**
 * 读取当前安装的 playwright-core 内置 chromium 版本元数据。
 *
 * 解决 persona 模板里硬编码 Chrome 版本号、与真实 chromium 引擎漂移的问题。
 * 一旦 playwright-core 升级，UA / Sec-CH-UA 也会自动跟随，避免出现
 * "browser claims Chrome 130 / detected Chrome 147" 这类反检测告警。
 *
 * SDK 同时被 ESM 原生加载（`pnpm dev` 直接跑）和被 vite 打包进
 * Electron main 的 CJS 产物（`main.cjs`），所以这个文件必须在两种宿主下
 * 都能找到 playwright-core 的 browsers.json。下面用 require.resolve 优先、
 * 再 walk-from-cwd 兜底、最后 hardcode 的三级策略。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// playwright-core@1.59.1 对应 chromium revision 1217。这是兜底值；正常情况下
// 都会从 browsers.json 读到准确版本。一旦 SDK 升级 playwright-core，记得同步改。
const FALLBACK_CHROME_VERSION = '147.0.7727.15';

interface BrowsersJson {
  browsers: Array<{ name: string; browserVersion?: string }>;
}

let cachedFullVersion: string | undefined;

function readVersionFromBrowsersJson(packageDir: string): string | undefined {
  try {
    const path = resolve(packageDir, 'browsers.json');
    if (!existsSync(path)) return undefined;
    const data = JSON.parse(readFileSync(path, 'utf8')) as BrowsersJson;
    const chromium = data.browsers.find((b) => b.name === 'chromium');
    return chromium?.browserVersion;
  } catch {
    return undefined;
  }
}

/**
 * Strategy A: 通过 `require.resolve('playwright-core/package.json')` 直接定位
 * 包根目录。两种情况下都可用：
 *   1. SDK 被 vite 打成 CJS（main.cjs），require 是 Node 注入的全局符号
 *   2. ESM 上下文下 globalThis.require 不存在，但走不到这条
 */
function tryRequireResolve(): string | undefined {
  const req = (globalThis as { require?: NodeJS.Require }).require;
  if (!req || typeof req.resolve !== 'function') return undefined;
  try {
    const pkgJson = req.resolve('playwright-core/package.json');
    return readVersionFromBrowsersJson(dirname(pkgJson));
  } catch {
    return undefined;
  }
}

/**
 * Strategy B: 从 process.cwd() 一路向上找 node_modules/playwright-core/browsers.json。
 * 适用于 ESM 原生加载 SDK 的场景（vitest、独立 Node 脚本）。
 */
function tryWalkFromCwd(): string | undefined {
  let dir = process.cwd();
  // 限制最多 8 层避免极端情况下死循环
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, 'node_modules', 'playwright-core');
    const v = readVersionFromBrowsersJson(candidate);
    if (v) return v;
    // pnpm 把真实包放在 .pnpm/playwright-core@x.y.z/node_modules/playwright-core
    // 但 hoisted symlink 通常在 node_modules/playwright-core 里指向那里，
    // 所以一般第一种就能命中；不去搜 .pnpm 目录避免不稳定。
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 返回 playwright-core 当前期望的 chromium 完整版本号，例如 "147.0.7727.15"。
 */
export function getInstalledChromeVersion(): string {
  if (cachedFullVersion) return cachedFullVersion;
  cachedFullVersion = tryRequireResolve() ?? tryWalkFromCwd() ?? FALLBACK_CHROME_VERSION;
  return cachedFullVersion;
}

/**
 * 提取主版本号（如 147）。
 */
export function getInstalledChromeMajor(): number {
  const major = getInstalledChromeVersion().split('.')[0];
  const n = Number.parseInt(major ?? '', 10);
  return Number.isFinite(n) ? n : 147;
}
