/**
 * Persona 文件存储：~/.mosaiq/personas/<id>.json
 *
 * 每个 persona 一个 JSON 文件，便于手工编辑、Git 管理、在设备间移动。
 * v0.1 明文存储；v0.2 会用 OS keychain 加密（cookies 仍然由 Chromium OSCrypt 处理）。
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deriveSeed,
  parsePersona,
  randomNoiseSeed,
  type NoiseSeed,
  type Persona,
  type PersonaId,
  type ProxyConfig,
} from '@mosaiq/persona-schema';

import { getPersonaDir, getPersonaFile, type PathConfig } from './paths.js';

/**
 * 保存 persona 到磁盘。内部会：
 *   1. 刷新 metadata.updatedAt 为当前时间
 *   2. 通过 parsePersona 做 schema 校验（防止写入坏数据）
 *   3. 写盘
 *
 * 返回值：**写入后**的 persona（含新 updatedAt）。调用方应使用返回值
 * 而非入参，否则入参的 updatedAt 字段不会反映磁盘上的值。
 */
export function savePersona(persona: Persona, config?: PathConfig): Persona {
  const toWrite: Persona = {
    ...persona,
    metadata: {
      ...persona.metadata,
      updatedAt: new Date().toISOString(),
    },
  };
  // 写盘前 schema 校验：防止 clonePersona/updatePersona 的错误 patch 写入坏数据
  // （之前仅 loadPersona 校验，意味着写入 → 下次 load 才报错，调试痛苦）
  const validated = parsePersona(toWrite);
  const file = getPersonaFile(validated.metadata.id, config);
  writeFileSync(file, JSON.stringify(validated, null, 2), 'utf-8');
  return validated;
}

export function loadPersona(id: PersonaId, config?: PathConfig): Persona {
  const file = getPersonaFile(id, config);
  if (!existsSync(file)) {
    throw new Error(`Persona not found: ${id} (expected at ${file})`);
  }
  const raw = readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return parsePersona(parsed);
}

export function listPersonas(config?: PathConfig): Persona[] {
  const dir = getPersonaDir(config);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const personas: Persona[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      personas.push(parsePersona(parsed));
    } catch (err) {
      console.warn(`[mosaiq] skipping invalid persona file ${f}:`, (err as Error).message);
    }
  }
  return personas;
}

export function deletePersona(id: PersonaId, config?: PathConfig): boolean {
  const file = getPersonaFile(id, config);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export function personaExists(id: PersonaId, config?: PathConfig): boolean {
  return existsSync(getPersonaFile(id, config));
}

/**
 * 允许在编辑流程中修改的字段。
 *
 * **故意不暴露**：硬件指纹（CPU/GPU/screen/canvas seed/...）、UA/OS/浏览器版本。
 * 这些字段一旦改变会破坏指纹一致性、和已有 cookies 不匹配、被反检测站标红。
 * 想换硬件请走「克隆 → 改指纹 → 新建」流程，保留旧 persona 的养号成果。
 */
export interface PersonaPatch {
  displayName?: string;
  tags?: readonly string[];
  notes?: string;
  /** IANA timezone，如 'America/New_York'。改时区时不一定改 locale */
  timezone?: string;
  /**
   * `undefined` = 不动；`null` = 移除代理；`ProxyConfig` 对象 = 替换。
   * 不支持 partial update，避免 host 改了 username 留旧值的不一致状态。
   */
  proxy?: ProxyConfig | null;
}

/**
 * 编辑已有 persona。原子写盘（先读取 + merge + 一次写入）。
 *
 * 注意：如果该 persona 当前正在运行，磁盘 JSON 会更新，但 chromium 进程已用旧
 * 配置启动，新值要等用户重启浏览器后才会生效。调用方应在 UI 上提示这点。
 */
export function updatePersona(
  id: PersonaId,
  patch: PersonaPatch,
  config?: PathConfig,
): Persona {
  const current = loadPersona(id, config);

  // 解释 patch.proxy 三态
  let newProxy: ProxyConfig | undefined;
  if (patch.proxy === null) {
    newProxy = undefined; // 显式移除
  } else if (patch.proxy === undefined) {
    newProxy = current.network.proxy; // 不动
  } else {
    newProxy = patch.proxy; // 替换
  }

  const updated: Persona = {
    ...current,
    metadata: {
      ...current.metadata,
      displayName: patch.displayName ?? current.metadata.displayName,
      tags: patch.tags !== undefined ? [...patch.tags] : current.metadata.tags,
      notes: patch.notes ?? current.metadata.notes,
    },
    system: patch.timezone
      ? { ...current.system, timezone: patch.timezone }
      : current.system,
    network: {
      ...current.network,
      proxy: newProxy,
    },
  };

  // savePersona 内部会刷新 updatedAt，用它的返回值以保证内存表示与磁盘一致
  return savePersona(updated, config);
}

/**
 * 克隆 persona 的入参。
 *
 * 会复制源 persona 的所有「身份基线」（OS / 浏览器 / 硬件 / 字体 / locale）。
 * 仅强制重新生成的字段：master noise seed → 派生出新的 canvas/webgl/audio 子 seed。
 *
 * 这样确保克隆出的 persona 与源 persona 在反检测站点上**指纹完全独立**，
 * 不会被识别为「同一台机器多账号」。
 */
export interface CloneOptions {
  /** 新 persona 的 ID，必须不与现有 persona 冲突 */
  newId: string;
  /** 新 persona 的显示名 */
  newDisplayName: string;
  /** undefined = 复制源；明确传值 = 覆盖 */
  newTags?: readonly string[];
  newNotes?: string;
  newTimezone?: string;
  /**
   * 同 PersonaPatch.proxy 的三态：
   *   - undefined = 复用源代理
   *   - null = 不带代理（裸连）
   *   - 对象 = 用新代理
   */
  newProxy?: ProxyConfig | null;
  /** 主 noise seed override；不传则随机生成新的（推荐） */
  newMasterSeed?: NoiseSeed;
}

/**
 * 基于现有 persona 创建一个新的，复制身份基线 + 重新派生指纹种子。
 *
 * 用法：账号矩阵（同 OS / 浏览器画像，但 cookie / IP / 指纹噪声完全独立）。
 *
 * 抛错：
 *   - 源 persona 不存在
 *   - newId 已被占用
 */
export function clonePersona(
  sourceId: PersonaId,
  options: CloneOptions,
  config?: PathConfig,
): Persona {
  const source = loadPersona(sourceId, config);
  const newIdTyped = options.newId as PersonaId;

  if (personaExists(newIdTyped, config)) {
    throw new Error(`Persona id "${options.newId}" already exists`);
  }

  const master = options.newMasterSeed ?? randomNoiseSeed();
  const now = new Date().toISOString();

  // proxy 三态
  let newProxy: ProxyConfig | undefined;
  if (options.newProxy === null) {
    newProxy = undefined;
  } else if (options.newProxy === undefined) {
    newProxy = source.network.proxy;
  } else {
    newProxy = options.newProxy;
  }

  const cloned: Persona = {
    ...source,
    metadata: {
      ...source.metadata,
      id: newIdTyped,
      displayName: options.newDisplayName,
      tags: options.newTags !== undefined ? [...options.newTags] : source.metadata.tags,
      notes: options.newNotes !== undefined ? options.newNotes : source.metadata.notes,
      createdAt: now,
      updatedAt: now,
      lastLaunchedAt: null,
      launchCount: 0,
    },
    system: options.newTimezone
      ? { ...source.system, timezone: options.newTimezone }
      : source.system,
    network: {
      ...source.network,
      proxy: newProxy,
    },
    fingerprint: {
      ...source.fingerprint,
      canvas: {
        ...source.fingerprint.canvas,
        noiseSeed: deriveSeed(master, 'canvas'),
      },
      webgl: {
        ...source.fingerprint.webgl,
        noiseSeed: deriveSeed(master, 'webgl'),
      },
      audio: {
        ...source.fingerprint.audio,
        noiseSeed: deriveSeed(master, 'audio'),
      },
    },
  };

  return savePersona(cloned, config);
}

/**
 * 记录一次启动，自增计数并刷新 lastLaunchedAt。
 */
export function recordLaunch(persona: Persona, config?: PathConfig): Persona {
  const now = new Date().toISOString();
  const updated: Persona = {
    ...persona,
    metadata: {
      ...persona.metadata,
      lastLaunchedAt: now,
      launchCount: persona.metadata.launchCount + 1,
      updatedAt: now,
    },
  };
  return savePersona(updated, config);
}
