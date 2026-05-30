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

import type { Persona } from '@runova/persona-schema';

export interface SpawnFlagsInput {
  persona: Persona;
  /**
   * chromium 内部监听的 CDP port（默认会 bind 127.0.0.1）。**不是**对外暴露的 port。
   * browser-pod 在外面跑一个 TCP relay 把 0.0.0.0:POD_CDP_PORT 转发到这个 port —— 因为
   * chromium issues.chromium.org/issues/40261787 已知 bug 让 --remote-debugging-address
   * 在 headless 模式下不生效，单靠 chromium 自己永远只 bind 127.0.0.1，相当于对外
   * ECONNREFUSED。relay 是绕开这个 bug 的最干净办法。
   */
  internalCdpPort: number;
  userDataDir: string;
  headless: boolean;
  viewport?: { width: number; height: number };
}

export function buildChromiumFlags(input: SpawnFlagsInput): string[] {
  const { persona, internalCdpPort, userDataDir, headless, viewport } = input;

  const width = viewport?.width ?? persona.system.screen.width;
  const height = viewport?.height ?? persona.system.screen.height;

  const flags: string[] = [
    // CDP 暴露。
    // 注意：故意不传 --remote-debugging-address —— chromium headless 模式下这个 flag
    // 不生效（已知 bug），写了反而误导以为已经 bind 0.0.0.0。让 chromium 默认 bind
    // 127.0.0.1:<internalCdpPort>，外面用 TCP relay 解决跨容器可达性。
    `--remote-debugging-port=${internalCdpPort}`,
    // chromium 111+ 在 devtools_http_handler 层强制 Origin / Host 头检查（防 DNS
    // rebinding）。即使 cdp proxy 在控制平面侧已经显式打 Origin: http://localhost，
    // 这个 flag 依然必要 —— 因为 cdp proxy 拨到 relay 时的 Host 头是 relay 外部
    // ip:port（172.18.0.3:9223），chromium 拿到 Host 后仍要校验。'*' 通配安全：
    // pod CDP 只在 docker user-defined network / Fly 6PN 内部可达，安全边界在网络层。
    `--remote-allow-origins=*`,

    // 持久化
    `--user-data-dir=${userDataDir}`,

    // 反检测基础项（与 SDK launcher.ts 一致）
    '--disable-blink-features=AutomationControlled',
    // MediaRouter / Cast 启动时会通过 dbus 探测设备，在没有 dbus 的容器里（Fly
    // firecracker / 多数 docker 镜像不带 dbus daemon）会卡 14 秒+ 才超时，把
    // chromium 整体启动时间从 ~3s 拖到 ~18s。2026-05-24 prod 部署踩坑：合并到
    // 同一个 --disable-features flag 里避免覆盖。
    '--disable-features=IsolateOrigins,site-per-process,MediaRouter',

    // 容器友好（multi-tenant pod 必须开 --no-sandbox 因为 chromium 进程
    // 已经在 gVisor / Firecracker 里被沙箱了，再开内层 setuid sandbox 反而
    // 在 Linux capabilities 受限的容器里启动不了）
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',

    // ─── 无 dbus / 无桌面环境的容器启动优化 ──────────────────────────────────
    // chromium 在没有 dbus daemon 的环境会反复尝试连 /run/dbus/system_bus_socket，
    // 每次失败 1-2s，启动期累积可达 15s+。下面这组 flags 关掉所有触发 dbus 的
    // 后台子系统，把启动时间从 ~18s 降到 ~3s。
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    // secret-service 走 dbus 找 gnome-keyring/kwallet，没桌面会 hang。
    // basic = 全内存假 store，per-session 进程结束就丢，正好符合 pod 模型。
    '--password-store=basic',
    '--use-mock-keychain',

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
