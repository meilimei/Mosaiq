/**
 * ManagedCloudSession —— `client.createSession()` 的返回值。
 *
 * 封装：
 *   - 服务端创建出来的 session 元信息（cdpUrl, persona, stealth）
 *   - injectInto(context)：把 persona 的 JS-level spoof 注入到 connectOverCDP
 *     之后拿到的 BrowserContext。SDK 内部用 @mosaiq/sdk/injection 的
 *     buildInjectionConfig + injectAll —— 与 desktop launcher 完全相同的注入
 *     脚本，保证 cloud session 与 desktop launchPersona() 行为一致。
 *   - close()：调控制平面 DELETE /v1/sessions/:id
 *
 * Humanize 由调用方通过 `import { Humanize } from '@mosaiq/sdk'` 直接构建，
 * 这里不强绑（cloud session 没有"first page"概念，page 由调用方掌控）。
 */

import type { BrowserContext } from 'playwright-core';

import type { Persona } from '@mosaiq/persona-schema';
import { buildInjectionConfig, injectAll } from '@mosaiq/sdk/injection';

import type { CreatedSession, MosaiqCloudClient, StealthInput } from './client.js';

export interface ManagedCloudSessionOptions {
  client: MosaiqCloudClient;
  created: CreatedSession;
}

export class ManagedCloudSession {
  readonly id: string;
  readonly projectId: string;
  readonly cdpUrl: string;
  readonly persona: Persona;
  readonly stealth: Required<StealthInput>;
  readonly expiresAt: string;
  readonly createdAt: string;

  readonly #client: MosaiqCloudClient;
  #closed = false;

  constructor(opts: ManagedCloudSessionOptions) {
    this.#client = opts.client;
    this.id = opts.created.id;
    this.projectId = opts.created.projectId;
    this.cdpUrl = opts.created.cdpUrl;
    this.persona = opts.created.persona;
    this.stealth = opts.created.stealth;
    this.expiresAt = opts.created.expiresAt;
    this.createdAt = opts.created.createdAt;
  }

  /**
   * 把 persona 的 JS-level spoof 注入到 connectOverCDP 之后拿到的 context。
   *
   * 口径（v0.11 起）：cloud 端 pod **默认已服务端注入**深层 stealth（canvas /
   * WebGL / audio / UA-CH / 字体 / worker scope），所以纯 `connectOverCDP`（含
   * `@browserbasehq/sdk` baseURL swap）也能拿到深层伪装，**不一定需要本方法**。
   * 本方法保留用于：(a) 想在客户端显式控制注入；(b) 服务端注入被关（session
   * `stealth.inject=false` 或 pod `POD_SERVER_INJECT=false`）时由客户端补注入。
   * 见 `docs/CLOUD-RUNTIME-ARCH.md` §2.5。
   *
   * 流程：
   *   1) 用 persona 派生 InjectionConfig（与 desktop launcher 完全相同）
   *   2) `context.addInitScript({ content })` —— 每个 page / iframe 加载前
   *      先跑这段脚本，拿到 navigator/screen/WebGL/Canvas/Audio 全套 spoof
   *
   * 关键：必须在 `await chromium.connectOverCDP(...)` 之后立刻调，且要在
   * 任何 `page.goto()` 之前。否则首屏指纹会用 raw chromium 值。
   *
   * 如果 `stealth.inject === false`，本方法 no-op（用户显式关闭）。
   *
   * 幂等：injectAll 自带 realm 级幂等保护（见 sdk runner.ts），即使服务端注入
   * 上线后与本方法同时生效、同一文档跑两遍，也只会注入一次，不会双重包装。
   */
  async injectInto(context: BrowserContext): Promise<void> {
    if (!this.stealth.inject) return;
    const config = buildInjectionConfig(this.persona);
    // 复用 SDK launcher 的同款注入脚本：先 polyfill esbuild __name helper，
    // 再 IIFE 调 injectAll(config)。launcher.ts 注释里详细讲了这一点。
    const namePolyfill = 'globalThis.__name=globalThis.__name||function(f){return f};';
    const script = `${namePolyfill}(${injectAll.toString()})(${JSON.stringify(config)});`;
    await context.addInitScript({ content: script });
  }

  /** 通过控制平面 DELETE /v1/sessions/:id 关闭。幂等。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#client.closeSession(this.id);
    } catch {
      // 关闭语义上幂等：服务端可能已经清掉了
    }
  }

  get closed(): boolean {
    return this.#closed;
  }
}
