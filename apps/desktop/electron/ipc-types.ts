/**
 * 主进程与渲染进程共享的 IPC 协议类型。
 * 所有 channel 命名空间用 'mosaiq:' 前缀。
 */

import type { Persona, PersonaId } from '@mosaiq/persona-schema';
import type { ProxyVerifyResult } from '@mosaiq/sdk';

export type { ProxyVerifyResult };

export interface ProxyVerifyInput {
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface PersonaSummary {
  id: PersonaId;
  displayName: string;
  tags: readonly string[];
  notes: string;
  os: string;
  browser: string;
  proxyLabel?: string;
  lastLaunchedAt: string | null;
  launchCount: number;
  isRunning: boolean;
}

export interface ProxyInput {
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
  label?: string;
}

export interface CreatePersonaInput {
  template:
    | 'win11-chrome-us'
    | 'win10-chrome-us'
    | 'macos-sonoma-chrome-us'
    | 'ubuntu-2204-chrome-us';
  id: string;
  displayName: string;
  tags?: string[];
  notes?: string;
  timezone?: string;
  proxy?: ProxyInput;
}

/**
 * 编辑 persona 的入参。所有字段都是 optional：未传 = 不动。
 *
 * 故意只允许这几个字段（不暴露硬件指纹），见 SDK PersonaPatch 文档。
 *
 * `proxy` 字段的三态：
 *   - `undefined`（不传）：不动
 *   - `null`：移除代理
 *   - `ProxyInput` 对象：替换
 */
export interface UpdatePersonaInput {
  displayName?: string;
  tags?: string[];
  notes?: string;
  timezone?: string;
  proxy?: ProxyInput | null;
}

/**
 * 克隆 persona 的入参。源 persona 的身份基线（OS / 浏览器 / 硬件）会被复制，
 * 但所有 noise seed 重新生成确保指纹完全独立。
 *
 * proxy 字段三态同 UpdatePersonaInput：
 *   - undefined = 复用源代理
 *   - null = 不带代理
 *   - 对象 = 用新代理
 */
export interface ClonePersonaInput {
  newId: string;
  newDisplayName: string;
  newTags?: string[];
  newNotes?: string;
  newTimezone?: string;
  newProxy?: ProxyInput | null;
}

/**
 * 导出结果三态：
 *   - ok:true → 文件已写入，savedTo 是绝对路径
 *   - canceled:true → 用户取消了 save dialog
 *   - error → 任何写盘 / 读 persona 失败
 */
export type ExportPersonaResult =
  | { ok: true; savedTo: string }
  | { ok: false; canceled: true }
  | { ok: false; error: string };

/**
 * 导入结果三态：
 *   - ok:true → persona 已落盘，summary 包含最终 id（可能因冲突被 rename）
 *   - canceled:true → 用户取消了 open dialog
 *   - error → JSON 解析 / schema 校验 / 写盘失败
 */
export type ImportPersonaResult =
  | { ok: true; persona: PersonaSummary; renamedFrom?: PersonaId }
  | { ok: false; canceled: true }
  | { ok: false; error: string };

export interface ExportPersonaOptions {
  /** 是否抹掉代理密码。默认 true（安全优先）。 */
  stripSecrets?: boolean;
}

export interface MosaiqApi {
  listPersonas(): Promise<PersonaSummary[]>;
  getPersona(id: PersonaId): Promise<Persona>;
  createPersona(input: CreatePersonaInput): Promise<PersonaSummary>;
  updatePersona(id: PersonaId, patch: UpdatePersonaInput): Promise<PersonaSummary>;
  clonePersona(sourceId: PersonaId, input: ClonePersonaInput): Promise<PersonaSummary>;
  deletePersona(id: PersonaId): Promise<boolean>;
  launchPersona(id: PersonaId): Promise<{ ok: true } | { ok: false; error: string }>;
  stopPersona(id: PersonaId): Promise<boolean>;
  getRunningPersonas(): Promise<PersonaId[]>;
  openDetectionLab(id: PersonaId): Promise<{ ok: true } | { ok: false; error: string }>;
  verifyProxy(input: ProxyVerifyInput): Promise<ProxyVerifyResult>;
  exportPersona(id: PersonaId, opts?: ExportPersonaOptions): Promise<ExportPersonaResult>;
  importPersona(): Promise<ImportPersonaResult>;
  appInfo(): Promise<{ runtimeRoot: string; version: string }>;
}

declare global {
  interface Window {
    mosaiq: MosaiqApi;
  }
}

export const IPC_CHANNELS = {
  listPersonas: 'mosaiq:listPersonas',
  getPersona: 'mosaiq:getPersona',
  createPersona: 'mosaiq:createPersona',
  updatePersona: 'mosaiq:updatePersona',
  clonePersona: 'mosaiq:clonePersona',
  deletePersona: 'mosaiq:deletePersona',
  launchPersona: 'mosaiq:launchPersona',
  stopPersona: 'mosaiq:stopPersona',
  getRunningPersonas: 'mosaiq:getRunningPersonas',
  openDetectionLab: 'mosaiq:openDetectionLab',
  verifyProxy: 'mosaiq:verifyProxy',
  exportPersona: 'mosaiq:exportPersona',
  importPersona: 'mosaiq:importPersona',
  appInfo: 'mosaiq:appInfo',
} as const;
