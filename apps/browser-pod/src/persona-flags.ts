/**
 * 把 Persona 翻译成 chromium cmdline 标志。
 *
 * 与 `@mosaiq/sdk` `launcher.ts` 保持口径一致 —— SDK 在 desktop 用
 * `chromium.launchPersistentContext({ proxy, locale, ... })`，最终也是落到
 * 同一组 chromium 标志。我们这里直接 spawn child_process，所以手工拼。
 *
 * **关键边界**：persona 的指纹（navigator.* / screen / WebGL 噪声等）由 SDK
 * 在 `connectOverCDP` 之后用 `addInitScript` 注入。pod 这边只覆盖 chromium
 * 进程级配置（proxy / lang / window-size / user-data-dir）。
 *
 * 这样设计的理由：pod 启动时不知道 SDK 端会怎么加固 —— 例如 stealth.inject=false
 * 时 SDK 不注入，但 pod 早起好了。把 chromium 级 vs JS 级解耦，一个 pod 镜像就能
 * 同时支持「最强 stealth」和「raw chromium」两种 mode。
 */

import type { Persona } from '@mosaiq/persona-schema';

export interface SpawnFlagsInput {
  persona: Persona;
  cdpPort: number;
  userDataDir: string;
  headless: boolean;
  viewport?: { width: number; height: number };
}

export function buildChromiumFlags(input: SpawnFlagsInput): string[] {
  const { persona, cdpPort, userDataDir, headless, viewport } = input;

  const width = viewport?.width ?? persona.system.screen.width;
  const height = viewport?.height ?? persona.system.screen.height;

  const flags: string[] = [
    // CDP 暴露
    `--remote-debugging-port=${cdpPort}`,
    `--remote-debugging-address=0.0.0.0`,
    // chromium 111+ 在 devtools_http_handler 层强制 Origin / Host 头检查（防 DNS
    // rebinding）。控制面板从 docker 容器 IP 连进来时 Host 不是 localhost，没这个 flag
    // chromium 会直接 reject WebSocket upgrade，cdp proxy 立刻收到 ws error → 客户端
    // 拿到 1011 "pod error"。pod 的 CDP 只在 docker user-defined network / Fly 6PN
    // 内部可达，'*' 等价于 "信任本子网"，安全边界已经在网络层。
    `--remote-allow-origins=*`,

    // 持久化
    `--user-data-dir=${userDataDir}`,

    // 反检测基础项（与 SDK launcher.ts 一致）
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',

    // 容器友好（multi-tenant pod 必须开 --no-sandbox 因为 chromium 进程
    // 已经在 gVisor / Firecracker 里被沙箱了，再开内层 setuid sandbox 反而
    // 在 Linux capabilities 受限的容器里启动不了）
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',

    // persona 派生
    `--lang=${persona.system.languages[0] ?? 'en-US'}`,
    `--window-size=${width},${height}`,
  ];

  // proxy
  if (persona.network.proxy) {
    const p = persona.network.proxy;
    const scheme = p.protocol === 'socks5' ? 'socks5' : p.protocol;
    flags.push(`--proxy-server=${scheme}://${p.host}:${p.port}`);
  }

  // WebRTC
  if (persona.fingerprint.webrtc.mode === 'proxy_only') {
    flags.push('--force-webrtc-ip-handling-policy=default_public_interface_only');
  }

  // headless mode
  if (headless) {
    // chrome 109+ uses --headless=new。老版本是 --headless。
    // playwright bundled chromium >= 1.40 都是新版，安全用 new。
    flags.push('--headless=new');
  }

  return flags;
}
