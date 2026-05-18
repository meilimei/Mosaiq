/**
 * 主进程与渲染进程共享的 IPC 协议类型。
 * 所有 channel 命名空间用 'mosaiq:' 前缀。
 */

import type { Persona, PersonaId } from '@mosaiq/persona-schema';
import type {
  DetectionRun,
  DetectionRunSummary,
  ProxyVerifyResult,
  RunProgressEvent,
} from '@mosaiq/sdk';

export type { DetectionRun, DetectionRunSummary, ProxyVerifyResult, RunProgressEvent };

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

/**
 * Detection Lab run 启动结果。
 *   - ok:true → run 已成功 kicked off（fire-and-forget），runId 是新生成的标识，
 *     调用方接下来订阅 `onDetectionLabProgress` 接收进度
 *   - ok:false → 通常因为该 persona 已有 in-flight run（单 persona 串行约束）
 *     或 persona 不存在
 */
export type DetectionRunStartResult = { ok: true; runId: string } | { ok: false; error: string };

/**
 * 推送给 renderer 的进度消息。
 *
 * `runId` 由 main.ts fire-and-forget 时生成 + IPC 启动响应同步返回，所以 renderer
 * 收到第一个 progress 事件前已经知道 runId（避免「不知道是哪次 run 的进度」的
 * race）。`progress.runId` 与 wrapper 的 `runId` 永远相等——重复字段是 belt-and-
 * suspenders，方便上层直接转发。
 */
export interface DetectionLabProgressMessage {
  runId: string;
  progress: RunProgressEvent;
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
  verifyProxy(input: ProxyVerifyInput): Promise<ProxyVerifyResult>;
  exportPersona(id: PersonaId, opts?: ExportPersonaOptions): Promise<ExportPersonaResult>;
  importPersona(): Promise<ImportPersonaResult>;
  appInfo(): Promise<{ runtimeRoot: string; version: string }>;

  // ── Phase 8.5 Detection Lab ────────────────────────────────────────────
  /** 启动一次 detection run（fire-and-forget）。立刻返回 runId；进度走 events。 */
  detectionLabRun(personaId: PersonaId): Promise<DetectionRunStartResult>;
  /** 中断 in-flight run；返回 true 表示找到并 abort 成功，false = 该 runId 不在 active 列表。 */
  detectionLabCancel(runId: string): Promise<boolean>;
  /** 列出 persona 的历史 run 摘要（按 startedAt 降序）。 */
  detectionLabListRuns(personaId: PersonaId): Promise<DetectionRunSummary[]>;
  /** 读取单次 run 完整数据；缺文件或 shape mismatch 抛错。 */
  detectionLabGetRun(personaId: PersonaId, runId: string): Promise<DetectionRun>;
  /** 删除单次 run（含 artifacts 子目录）；false = 文件本来就不存在。 */
  detectionLabDeleteRun(personaId: PersonaId, runId: string): Promise<boolean>;
}

/**
 * 主进程推送给 renderer 的事件 API（contextBridge 单独 expose，与 invoke API 分开）。
 *
 * 每个订阅函数返回 cleanup 函数，调用即取消订阅（避免 effect unmount 后还在收事件）。
 */
export interface MosaiqEvents {
  /** Persona 浏览器被用户手动关闭时触发。 */
  onPersonaStopped(cb: (id: PersonaId) => void): () => void;
  /** Detection Lab run 进度事件（init / site-start / site-retry / site-end / done / canceled / error）。 */
  onDetectionLabProgress(cb: (msg: DetectionLabProgressMessage) => void): () => void;
}

declare global {
  interface Window {
    mosaiq: MosaiqApi;
    mosaiqEvents: MosaiqEvents;
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
  verifyProxy: 'mosaiq:verifyProxy',
  exportPersona: 'mosaiq:exportPersona',
  importPersona: 'mosaiq:importPersona',
  appInfo: 'mosaiq:appInfo',
  detectionLabRun: 'mosaiq:detectionLab:run',
  detectionLabCancel: 'mosaiq:detectionLab:cancel',
  detectionLabListRuns: 'mosaiq:detectionLab:listRuns',
  detectionLabGetRun: 'mosaiq:detectionLab:getRun',
  detectionLabDeleteRun: 'mosaiq:detectionLab:deleteRun',
} as const;

/**
 * 主进程 → renderer 的单向 push 事件 channel。与 IPC_CHANNELS（invoke/handle）
 * 分开命名避免误用。
 */
export const IPC_EVENTS = {
  personaStopped: 'mosaiq:personaStopped',
  detectionLabProgress: 'mosaiq:detectionLab:progress',
} as const;
