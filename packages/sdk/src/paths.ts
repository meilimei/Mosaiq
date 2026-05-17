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

/**
 * Detection runs 顶层目录：`<runtimeRoot>/detection-runs/`。
 *
 * 与 personas / profiles 平级。每个 persona 的所有历史 detection run 都嵌在
 * 此目录下的 `<personaId>/` 子目录里——既方便按 persona 整体删除（删人即删
 * 历史），也方便 sync / Git tracking 单个 persona 的检测演进。
 *
 * v0.8 Phase 8.4 起加入；纯字符串拼接，**不副作用 mkdir**——副作用留给
 * `saveDetectionRun` 显式处理，让 list / load 路径保持读语义无副作用。
 */
export function getDetectionRunsRoot(config?: PathConfig): string {
  return resolve(getRuntimeRoot(config), 'detection-runs');
}

/**
 * 单个 persona 的 detection runs 目录：`<runtimeRoot>/detection-runs/<personaId>/`。
 *
 * **不副作用 mkdir** — 见 getDetectionRunsRoot 注释。如果该 persona 从未跑过
 * detection，listDetectionRuns 看到目录不存在直接返回 `[]`。
 */
export function getDetectionRunsDir(personaId: PersonaId, config?: PathConfig): string {
  return join(getDetectionRunsRoot(config), personaId);
}

/**
 * 单次 detection run 的 JSON 文件路径：`<...>/<personaId>/<runId>.json`。
 *
 * 同名目录 `<runId>/` 用作 artifacts（screenshots / html）的子目录——见
 * `getDetectionRunArtifactDir`（位于 run-store.ts）。两者同名分别为文件 +
 * 目录是有意设计：一次 run 的所有产物（JSON + 截图）按 prefix `<runId>` 聚
 * 合，方便整体 rm。
 */
export function getDetectionRunFile(
  personaId: PersonaId,
  runId: string,
  config?: PathConfig,
): string {
  return join(getDetectionRunsDir(personaId, config), `${runId}.json`);
}
