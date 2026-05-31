/**
 * captcha.ts 单测。
 *
 * 重点覆盖最易出错、最有价值的部分：
 *   - detectCaptchaFn：对各类 captcha 嵌入方式的命中（纯函数，传 fake doc/location）
 *   - createCaptchaSolver：provider / key gating
 *   - CapSolverProvider.solve：createTask → 轮询 getTaskResult 的成功/失败路径（mock fetch）
 *
 * 不依赖真实浏览器 / DOM —— detectCaptchaFn 用最小结构化 doc 直接调。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapSolverProvider, createCaptchaSolver, detectCaptchaFn } from './captcha.js';
import type { Env } from './env.js';

// ─── 测试用 fake DOM ─────────────────────────────────────────────────────────

function el(attrs: Record<string, string>): { getAttribute(name: string): string | null } {
  return { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
}

function makeDoc(opts: {
  single?: Record<string, { getAttribute(name: string): string | null }>;
  frames?: Array<{ getAttribute(name: string): string | null }>;
}): {
  querySelector(sel: string): { getAttribute(name: string): string | null } | null;
  querySelectorAll(sel: string): Array<{ getAttribute(name: string): string | null }>;
} {
  const single = opts.single ?? {};
  const frames = opts.frames ?? [];
  return {
    querySelector: (sel) => single[sel] ?? null,
    querySelectorAll: (sel) => (sel === 'iframe[src]' ? frames : []),
  };
}

const LOC = { href: 'https://example.com/submit' };

const SEL_TURNSTILE = '.cf-turnstile[data-sitekey]';
const SEL_HCAPTCHA = '.h-captcha[data-sitekey], [data-hcaptcha-widget-id]';
const SEL_RECAPTCHA = '.g-recaptcha[data-sitekey], [data-sitekey].g-recaptcha';

describe('detectCaptchaFn', () => {
  it('detects Cloudflare Turnstile by data-sitekey container', () => {
    const doc = makeDoc({ single: { [SEL_TURNSTILE]: el({ 'data-sitekey': '0xAAA' }) } });
    expect(detectCaptchaFn(doc, LOC)).toEqual({
      kind: 'turnstile',
      siteKey: '0xAAA',
      pageUrl: LOC.href,
    });
  });

  it('detects hCaptcha by data-sitekey container', () => {
    const doc = makeDoc({ single: { [SEL_HCAPTCHA]: el({ 'data-sitekey': 'hk-123' }) } });
    expect(detectCaptchaFn(doc, LOC)).toEqual({
      kind: 'hcaptcha',
      siteKey: 'hk-123',
      pageUrl: LOC.href,
    });
  });

  it('detects reCAPTCHA v2 (checkbox)', () => {
    const doc = makeDoc({ single: { [SEL_RECAPTCHA]: el({ 'data-sitekey': 'rk-1' }) } });
    expect(detectCaptchaFn(doc, LOC)).toEqual({
      kind: 'recaptcha_v2',
      siteKey: 'rk-1',
      pageUrl: LOC.href,
    });
  });

  it('detects reCAPTCHA v3 when size=invisible and carries action', () => {
    const doc = makeDoc({
      single: {
        [SEL_RECAPTCHA]: el({
          'data-sitekey': 'rk-3',
          'data-size': 'invisible',
          'data-action': 'login',
        }),
      },
    });
    expect(detectCaptchaFn(doc, LOC)).toEqual({
      kind: 'recaptcha_v3',
      siteKey: 'rk-3',
      pageUrl: LOC.href,
      action: 'login',
    });
  });

  it('falls back to recaptcha iframe src (k=...) when no data-sitekey container', () => {
    const doc = makeDoc({
      frames: [
        el({ src: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=IFRAME_KEY&co=abc' }),
      ],
    });
    expect(detectCaptchaFn(doc, LOC)).toEqual({
      kind: 'recaptcha_v2',
      siteKey: 'IFRAME_KEY',
      pageUrl: LOC.href,
    });
  });

  it('falls back to hcaptcha iframe src (sitekey=...)', () => {
    const doc = makeDoc({
      frames: [
        el({
          src: 'https://newassets.hcaptcha.com/captcha/v1/x/static?sitekey=HK_IFRAME&theme=light',
        }),
      ],
    });
    expect(detectCaptchaFn(doc, LOC)).toEqual({
      kind: 'hcaptcha',
      siteKey: 'HK_IFRAME',
      pageUrl: LOC.href,
    });
  });

  it('prioritises Turnstile over reCAPTCHA when both present', () => {
    const doc = makeDoc({
      single: {
        [SEL_TURNSTILE]: el({ 'data-sitekey': 'ts-win' }),
        [SEL_RECAPTCHA]: el({ 'data-sitekey': 'rc-lose' }),
      },
    });
    expect(detectCaptchaFn(doc, LOC)?.kind).toBe('turnstile');
  });

  it('returns null when no captcha present', () => {
    expect(detectCaptchaFn(makeDoc({}), LOC)).toBeNull();
  });
});

// ─── createCaptchaSolver gating ──────────────────────────────────────────────

function envWith(partial: Partial<Env>): Env {
  return {
    POD_CAPTCHA_PROVIDER: 'none',
    POD_CAPTCHA_API_KEY: '',
    POD_CAPTCHA_TIMEOUT_MS: 120_000,
    ...partial,
  } as unknown as Env;
}

describe('createCaptchaSolver', () => {
  it('returns null for provider=none', () => {
    expect(createCaptchaSolver(envWith({ POD_CAPTCHA_PROVIDER: 'none' }))).toBeNull();
  });

  it('returns null for capsolver without api key', () => {
    expect(
      createCaptchaSolver(envWith({ POD_CAPTCHA_PROVIDER: 'capsolver', POD_CAPTCHA_API_KEY: '' })),
    ).toBeNull();
  });

  it('returns a CapSolverProvider when provider+key configured', () => {
    const solver = createCaptchaSolver(
      envWith({ POD_CAPTCHA_PROVIDER: 'capsolver', POD_CAPTCHA_API_KEY: 'cs_test' }),
    );
    expect(solver).toBeInstanceOf(CapSolverProvider);
    expect(solver?.name).toBe('capsolver');
  });
});

// ─── CapSolverProvider.solve（mock fetch）─────────────────────────────────────

const CHALLENGE = {
  kind: 'recaptcha_v2' as const,
  siteKey: 'k',
  pageUrl: 'https://example.com/submit',
};

function jsonResponse(body: unknown): Response {
  return { json: () => Promise.resolve(body) } as unknown as Response;
}

describe('CapSolverProvider.solve', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns token on createTask → ready', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errorId: 0, taskId: 'task-1' }))
      .mockResolvedValueOnce(
        jsonResponse({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'TOKEN_OK' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CapSolverProvider('cs_test', 5_000, 5);
    const result = await provider.solve(CHALLENGE, new AbortController().signal);

    expect(result).toEqual({ token: 'TOKEN_OK' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/createTask');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/getTaskResult');
  });

  it('polls while processing then resolves token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errorId: 0, taskId: 'task-2' }))
      .mockResolvedValueOnce(jsonResponse({ errorId: 0, status: 'processing' }))
      .mockResolvedValueOnce(
        jsonResponse({ errorId: 0, status: 'ready', solution: { token: 'TS_TOKEN' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CapSolverProvider('cs_test', 5_000, 5);
    const result = await provider.solve(CHALLENGE, new AbortController().signal);

    expect(result).toEqual({ token: 'TS_TOKEN' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns null when createTask errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errorId: 1, errordescription: 'bad key' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CapSolverProvider('cs_bad', 5_000, 5);
    const result = await provider.solve(CHALLENGE, new AbortController().signal);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null immediately when signal already aborted', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ errorId: 0, taskId: 'task-3' }));
    vi.stubGlobal('fetch', fetchMock);

    const ctrl = new AbortController();
    ctrl.abort();
    const provider = new CapSolverProvider('cs_test', 5_000, 5);
    const result = await provider.solve(CHALLENGE, ctrl.signal);

    expect(result).toBeNull();
  });
});
