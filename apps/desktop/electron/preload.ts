/**
 * Preload 脚本。在 contextIsolation 启用下，通过 contextBridge 把
 * 受限的 Mosaiq API 暴露给 renderer，不暴露任何 Node API。
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { PersonaId } from '@mosaiq/persona-schema';

import {
  IPC_CHANNELS,
  type ClonePersonaInput,
  type CreatePersonaInput,
  type MosaiqApi,
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
  appInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
};

contextBridge.exposeInMainWorld('mosaiq', api);

// Event: persona 被用户手动关闭浏览器时的通知
contextBridge.exposeInMainWorld('mosaiqEvents', {
  onPersonaStopped: (cb: (id: PersonaId) => void) => {
    const listener = (_evt: unknown, id: PersonaId) => cb(id);
    ipcRenderer.on('mosaiq:personaStopped', listener);
    return () => ipcRenderer.off('mosaiq:personaStopped', listener);
  },
});
