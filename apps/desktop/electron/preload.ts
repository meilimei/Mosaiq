/**
 * Preload 脚本。在 contextIsolation 启用下，通过 contextBridge 把
 * 受限的 Mosaiq API 暴露给 renderer，不暴露任何 Node API。
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { PersonaId } from '@mosaiq/persona-schema';

import {
  IPC_CHANNELS,
  IPC_EVENTS,
  type ClonePersonaInput,
  type CreatePersonaInput,
  type DetectionLabProgressMessage,
  type ExportPersonaOptions,
  type MosaiqApi,
  type MosaiqEvents,
  type ProxyVerifyInput,
  type UpdatePersonaInput,
} from './ipc-types.js';

const api: MosaiqApi = {
  listPersonas: () => ipcRenderer.invoke(IPC_CHANNELS.listPersonas),
  getPersona: (id: PersonaId) => ipcRenderer.invoke(IPC_CHANNELS.getPersona, id),
  createPersona: (input: CreatePersonaInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.createPersona, input),
  updatePersona: (id: PersonaId, patch: UpdatePersonaInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.updatePersona, id, patch),
  clonePersona: (sourceId: PersonaId, input: ClonePersonaInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.clonePersona, sourceId, input),
  deletePersona: (id: PersonaId) => ipcRenderer.invoke(IPC_CHANNELS.deletePersona, id),
  launchPersona: (id: PersonaId) => ipcRenderer.invoke(IPC_CHANNELS.launchPersona, id),
  stopPersona: (id: PersonaId) => ipcRenderer.invoke(IPC_CHANNELS.stopPersona, id),
  getRunningPersonas: () => ipcRenderer.invoke(IPC_CHANNELS.getRunningPersonas),
  openDetectionLab: (id: PersonaId) => ipcRenderer.invoke(IPC_CHANNELS.openDetectionLab, id),
  verifyProxy: (input: ProxyVerifyInput) => ipcRenderer.invoke(IPC_CHANNELS.verifyProxy, input),
  exportPersona: (id: PersonaId, opts?: ExportPersonaOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportPersona, id, opts ?? {}),
  importPersona: () => ipcRenderer.invoke(IPC_CHANNELS.importPersona),
  appInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),

  // ── Phase 8.5 Detection Lab ──────────────────────────────────────────────
  detectionLabRun: (personaId: PersonaId) =>
    ipcRenderer.invoke(IPC_CHANNELS.detectionLabRun, personaId),
  detectionLabCancel: (runId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.detectionLabCancel, runId),
  detectionLabListRuns: (personaId: PersonaId) =>
    ipcRenderer.invoke(IPC_CHANNELS.detectionLabListRuns, personaId),
  detectionLabGetRun: (personaId: PersonaId, runId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.detectionLabGetRun, personaId, runId),
  detectionLabDeleteRun: (personaId: PersonaId, runId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.detectionLabDeleteRun, personaId, runId),
};

const events: MosaiqEvents = {
  onPersonaStopped: (cb: (id: PersonaId) => void) => {
    const listener = (_evt: unknown, id: PersonaId) => cb(id);
    ipcRenderer.on(IPC_EVENTS.personaStopped, listener);
    return () => ipcRenderer.off(IPC_EVENTS.personaStopped, listener);
  },
  onDetectionLabProgress: (cb: (msg: DetectionLabProgressMessage) => void) => {
    const listener = (_evt: unknown, msg: DetectionLabProgressMessage) => cb(msg);
    ipcRenderer.on(IPC_EVENTS.detectionLabProgress, listener);
    return () => ipcRenderer.off(IPC_EVENTS.detectionLabProgress, listener);
  },
};

contextBridge.exposeInMainWorld('mosaiq', api);
contextBridge.exposeInMainWorld('mosaiqEvents', events);
