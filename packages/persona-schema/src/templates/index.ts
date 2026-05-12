/**
 * Persona 模板库入口。
 * 新增模板：实现一个 createXxxPersona(input) -> Persona 函数并在此导出。
 */

export { createWin11ChromeUsPersona, type Win11ChromeUsInput } from './win11-chrome-us.js';
export { createWin10ChromeUsPersona, type Win10ChromeUsInput } from './win10-chrome-us.js';
export {
  createMacosSonomaChromeUsPersona,
  type MacosSonomaChromeUsInput,
} from './macos-sonoma-chrome-us.js';
export {
  createUbuntu2204ChromeUsPersona,
  type Ubuntu2204ChromeUsInput,
} from './ubuntu-2204-chrome-us.js';
export {
  WIN10_FONTS,
  WIN11_FONTS,
  MACOS_SONOMA_FONTS,
  UBUNTU_2204_FONTS,
} from './fonts.js';

import { createMacosSonomaChromeUsPersona } from './macos-sonoma-chrome-us.js';
import { createUbuntu2204ChromeUsPersona } from './ubuntu-2204-chrome-us.js';
import { createWin10ChromeUsPersona } from './win10-chrome-us.js';
import { createWin11ChromeUsPersona } from './win11-chrome-us.js';

/**
 * 所有可用模板的清单，供 CLI / Desktop UI 枚举。
 */
export const TEMPLATE_CATALOG = [
  {
    id: 'win11-chrome-us',
    displayName: 'Windows 11 + Chrome 130 (US)',
    description: 'Win11 23H2 / Chrome 130 / 1920×1080 / 8 核 / 8GB。Reddit 用户最常见配置。',
    create: createWin11ChromeUsPersona,
  },
  {
    id: 'win10-chrome-us',
    displayName: 'Windows 10 22H2 + Chrome 130 (US)',
    description:
      'Win10 22H2 / Chrome 130 / 1920×1080 / 4 核 / 8GB。企业及老 PC 用户群体（Win10 仍占 ~30%）。',
    create: createWin10ChromeUsPersona,
  },
  {
    id: 'macos-sonoma-chrome-us',
    displayName: 'macOS Sonoma + Chrome 130 (US)',
    description: 'macOS 14.6 (Apple M2) / Chrome 130 / 1470×956 retina。Reddit Mac 用户主配置。',
    create: createMacosSonomaChromeUsPersona,
  },
  {
    id: 'ubuntu-2204-chrome-us',
    displayName: 'Ubuntu 22.04 + Chrome 130 (US)',
    description:
      'Ubuntu 22.04 LTS / Chrome 130 / Intel Mesa / 1920×1080。开发者 / HN / GitHub 画像；不适合消费类站点。',
    create: createUbuntu2204ChromeUsPersona,
  },
] as const;

export type TemplateId = (typeof TEMPLATE_CATALOG)[number]['id'];
