/**
 * BrowserSession — launchPersona() 的返回值。
 *
 * 封装了 Playwright BrowserContext 与 Persona 元信息，提供：
 *   - context 直接访问（传给 Stagehand / browser-use）
 *   - 第一个 page 的便捷 getter
 *   - close() 统一关闭
 *   - Reddit / 通用站点的快捷操作（v0.1 占位，v0.2 填充）
 */

import type { BrowserContext, Page } from 'playwright-core';

import type { Persona } from '@mosaiq/persona-schema';

export class BrowserSession {
  readonly persona: Persona;
  readonly context: BrowserContext;
  #closed = false;

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
