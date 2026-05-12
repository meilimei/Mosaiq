/**
 * BrowserSession — launchPersona() 的返回值。
 *
 * 封装了 Playwright BrowserContext 与 Persona 元信息，提供：
 *   - context 直接访问（传给 Stagehand / browser-use）
 *   - 第一个 page 的便捷 getter
 *   - close() 统一关闭
 *   - humanize：v0.2 起，对 firstPage() 上的鼠标/键盘做类人节律包装
 */

import type { BrowserContext, Page } from 'playwright-core';

import type { Persona } from '@mosaiq/persona-schema';
import { Humanize, type HumanizeDefaults } from './humanize/index.js';

export class BrowserSession {
  readonly persona: Persona;
  readonly context: BrowserContext;
  #closed = false;
  #humanize: Humanize | null = null;
  #humanizePage: Page | null = null;

  constructor(context: BrowserContext, persona: Persona) {
    this.context = context;
    this.persona = persona;
  }

  /**
   * 获取（或创建）第一个 page。launchPersistentContext 默认打开一个空 tab。
   */
  async firstPage(): Promise<Page> {
    const pages = this.context.pages();
    if (pages.length > 0) {
      const p = pages[0];
      if (p) return p;
    }
    return await this.context.newPage();
  }

  /**
   * 打开新 tab 并跳转。
   */
  async open(url: string): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page;
  }

  /**
   * 类人输入引擎。绑定到 firstPage()。
   *
   * 同一个 session 内多次调用复用同一 Humanize 实例（内部 RNG 状态延续，避免
   * 「同 persona 第二次输入和第一次完全一样」这种回放风险）。
   *
   * 跨 tab 操作：建议直接 `new Humanize(otherPage, { seed: ... })`，因为切换 tab
   * 后鼠标位置缓存不再有效。
   */
  async humanize(opts: HumanizeDefaults = {}): Promise<Humanize> {
    const page = await this.firstPage();
    if (this.#humanize && this.#humanizePage === page) return this.#humanize;
    // 默认 seed 从 persona 派生，保证「同 persona = 一致风格」便于排查回放
    const seed = opts.seed ?? `humanize:${this.persona.metadata.id}`;
    this.#humanize = new Humanize(page, { ...opts, seed });
    this.#humanizePage = page;
    return this.#humanize;
  }

  /**
   * 关闭 session（底层 context + browser）。幂等。
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.context.close();
    } catch {
      // browser 已被外部关闭
    }
  }

  get closed(): boolean {
    return this.#closed;
  }
}
