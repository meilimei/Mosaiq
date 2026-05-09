/**
 * User-Agent 字符串生成。
 * v0.1 只覆盖 Chrome on Windows / macOS，其他浏览器走 persona.browser.userAgent 显式传入。
 */

import type { Persona } from '@mosaiq/persona-schema';

export function buildUserAgent(persona: Persona): string {
  const { os, screen: _screen } = persona.system;
  const { brand, fullVersion } = persona.browser;

  if (brand !== 'chrome') {
    throw new Error(
      `buildUserAgent v0.1 only supports Chrome; got '${brand}'. ` +
        'Please supply persona.browser.userAgent explicitly for non-Chrome brands.',
    );
  }

  const platformToken = buildPlatformToken(os);
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`;
}

function buildPlatformToken(os: Persona['system']['os']): string {
  switch (os.family) {
    case 'windows': {
      // Win11 UA 仍报 Windows NT 10.0（Microsoft 未升 UA 版本号）
      const wow = os.arch === 'x86_64' ? '; Win64; x64' : '';
      return `Windows NT 10.0${wow}`;
    }
    case 'macos': {
      // UA 中仍用 Intel Mac OS X 格式（即使 Apple Silicon）
      const macVersion = os.version.split('.').slice(0, 2).join('_');
      return `Macintosh; Intel Mac OS X 10_15_${macVersion.split('_')[1] ?? '7'}`;
    }
    case 'linux':
      return `X11; Linux ${os.arch === 'x86_64' ? 'x86_64' : 'i686'}`;
    default:
      throw new Error(`Unsupported OS family for UA: ${os.family}`);
  }
}

/**
 * 生成 Accept-Language 头。例：'en-US,en;q=0.9'
 */
export function buildAcceptLanguage(persona: Persona): string {
  const langs = persona.system.languages;
  return langs
    .map((lang: string, i: number) => (i === 0 ? lang : `${lang};q=${(0.9 - i * 0.1).toFixed(1)}`))
    .join(',');
}
