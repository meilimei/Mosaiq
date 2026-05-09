/**
 * Profile directory 管理：为每个 persona 分配独立的 --user-data-dir，
 * 确保 cookies / localStorage / indexedDB 跨 persona 完全隔离。
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

import type { PersonaId } from '@mosaiq/persona-schema';

export interface PathConfig {
  /**
   * 运行时根目录。默认 ~/.mosaiq/
   * Desktop / CLI 可覆盖（例 Desktop 用 appDataDir）
   */
  runtimeRoot?: string;
}

export function getRuntimeRoot(config?: PathConfig): string {
  if (config?.runtimeRoot) return config.runtimeRoot;
  const envRoot = process.env.MOSAIQ_RUNTIME_ROOT;
  if (envRoot) return envRoot;
  return join(homedir(), '.mosaiq');
}

/**
 * 每个 persona 的浏览器 user-data-dir 路径。
 * 同一 persona 多次启动总指向同一目录，cookies 持久化。
 */
export function getUserDataDir(personaId: PersonaId, config?: PathConfig): string {
  const dir = resolve(getRuntimeRoot(config), 'profiles', personaId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persona JSON 存储目录。
 */
export function getPersonaDir(config?: PathConfig): string {
  const dir = resolve(getRuntimeRoot(config), 'personas');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 特定 persona JSON 文件路径。
 */
export function getPersonaFile(personaId: PersonaId, config?: PathConfig): string {
  return join(getPersonaDir(config), `${personaId}.json`);
}
