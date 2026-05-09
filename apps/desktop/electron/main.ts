/**
 * Electron 主进程。
 *   - 创建窗口
 *   - 注册 IPC handlers（直接调用 @mosaiq/sdk）
 *   - 跟踪每个 persona 的运行中 session
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';

import type { PersonaId } from '@mosaiq/persona-schema';
import {
  BrowserSession,
  clonePersona as sdkClonePersona,
  deletePersona as sdkDeletePersona,
  launchPersona as sdkLaunchPersona,
  listPersonas as sdkListPersonas,
  loadPersona,
  recordLaunch,
  savePersona,
  updatePersona as sdkUpdatePersona,
  verifyProxy,
} from '@mosaiq/sdk';
import {
  createWin11ChromeUsPersona,
  createMacosSonomaChromeUsPersona,
} from '@mosaiq/persona-schema/templates';

import {
  IPC_CHANNELS,
  type ClonePersonaInput,
  type CreatePersonaInput,
  type PersonaSummary,
  type ProxyVerifyInput,
  type UpdatePersonaInput,
} from './ipc-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 窗口
// ─────────────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0b0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行中 session 注册表
// ─────────────────────────────────────────────────────────────────────────────

const runningSessions = new Map<PersonaId, BrowserSession>();

function buildSummary(personaId: PersonaId, persona: ReturnType<typeof loadPersona>): PersonaSummary {
  return {
    id: personaId,
    displayName: persona.metadata.displayName,
    tags: persona.metadata.tags,
    notes: persona.metadata.notes,
    os: `${persona.system.os.family} ${persona.system.os.version}`,
    browser: `${persona.browser.brand} ${persona.browser.majorVersion}`,
    proxyLabel: persona.network.proxy?.label,
    lastLaunchedAt: persona.metadata.lastLaunchedAt,
    launchCount: persona.metadata.launchCount,
    isRunning: runningSessions.has(personaId),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC handlers
// ─────────────────────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.listPersonas, (): PersonaSummary[] => {
    const personas = sdkListPersonas();
    return personas.map((p) => buildSummary(p.metadata.id, p));
  });

  ipcMain.handle(IPC_CHANNELS.getPersona, (_evt, id: PersonaId) => {
    return loadPersona(id);
  });

  ipcMain.handle(IPC_CHANNELS.createPersona, (_evt, input: CreatePersonaInput): PersonaSummary => {
    const parsedId = input.id as PersonaId;
    let persona;
    switch (input.template) {
      case 'win11-chrome-us':
        persona = createWin11ChromeUsPersona({
          id: parsedId,
          displayName: input.displayName,
          tags: input.tags,
          notes: input.notes,
          timezone: input.timezone,
          proxy: input.proxy,
        });
        break;
      case 'macos-sonoma-chrome-us':
        persona = createMacosSonomaChromeUsPersona({
          id: parsedId,
          displayName: input.displayName,
          tags: input.tags,
          notes: input.notes,
          timezone: input.timezone,
          proxy: input.proxy,
        });
        break;
      default:
        throw new Error(`Unknown template: ${input.template}`);
    }
    savePersona(persona);
    return buildSummary(persona.metadata.id, persona);
  });

  ipcMain.handle(
    IPC_CHANNELS.updatePersona,
    (_evt, id: PersonaId, patch: UpdatePersonaInput): PersonaSummary => {
      // IPC ProxyInput 没暴露 bypassList（前端不编辑），main 这里补 [] 给 SDK
      const sdkProxy =
        patch.proxy === undefined
          ? undefined
          : patch.proxy === null
            ? null
            : { ...patch.proxy, bypassList: [] };
      const updated = sdkUpdatePersona(id, {
        displayName: patch.displayName,
        tags: patch.tags,
        notes: patch.notes,
        timezone: patch.timezone,
        proxy: sdkProxy,
      });
      return buildSummary(updated.metadata.id, updated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.clonePersona,
    (_evt, sourceId: PersonaId, input: ClonePersonaInput): PersonaSummary => {
      const sdkProxy =
        input.newProxy === undefined
          ? undefined
          : input.newProxy === null
            ? null
            : { ...input.newProxy, bypassList: [] };
      const cloned = sdkClonePersona(sourceId, {
        newId: input.newId,
        newDisplayName: input.newDisplayName,
        newTags: input.newTags,
        newNotes: input.newNotes,
        newTimezone: input.newTimezone,
        newProxy: sdkProxy,
      });
      return buildSummary(cloned.metadata.id, cloned);
    },
  );

  ipcMain.handle(IPC_CHANNELS.deletePersona, (_evt, id: PersonaId) => {
    const session = runningSessions.get(id);
    if (session) {
      void session.close();
      runningSessions.delete(id);
    }
    return sdkDeletePersona(id);
  });

  ipcMain.handle(IPC_CHANNELS.launchPersona, async (_evt, id: PersonaId) => {
    if (runningSessions.has(id)) {
      return { ok: false as const, error: `Persona ${id} is already running` };
    }
    try {
      const persona = loadPersona(id);
      recordLaunch(persona);
      const session = await sdkLaunchPersona(persona, { headless: false });
      runningSessions.set(id, session);
      // 当浏览器被用户关闭时，清理注册表
      session.context.on('close', () => {
        runningSessions.delete(id);
        mainWindow?.webContents.send('mosaiq:personaStopped', id);
      });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.stopPersona, async (_evt, id: PersonaId) => {
    const session = runningSessions.get(id);
    if (!session) return false;
    await session.close();
    runningSessions.delete(id);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.getRunningPersonas, (): PersonaId[] => {
    return Array.from(runningSessions.keys());
  });

  ipcMain.handle(IPC_CHANNELS.openDetectionLab, async (_evt, id: PersonaId) => {
    const session = runningSessions.get(id);
    if (!session) {
      return { ok: false as const, error: `Persona ${id} 未启动，请先启动浏览器` };
    }
    try {
      await session.open('https://pixelscan.net/');
      const page = await session.context.newPage();
      await page.goto('https://browserscan.net/', { waitUntil: 'domcontentloaded' });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.verifyProxy, async (_evt, input: ProxyVerifyInput) => {
    return verifyProxy({
      protocol: input.protocol,
      host: input.host,
      port: input.port,
      username: input.username,
      password: input.password,
      bypassList: [],
    });
  });

  ipcMain.handle(IPC_CHANNELS.appInfo, () => {
    return {
      runtimeRoot: process.env.MOSAIQ_RUNTIME_ROOT ?? '~/.mosaiq',
      version: app.getVersion(),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createWindow();
});

app.on('window-all-closed', async () => {
  // 关闭所有运行中的 persona session
  for (const [, session] of runningSessions) {
    await session.close().catch(() => {});
  }
  runningSessions.clear();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

// 安全策略：阻止新窗口
app.on('web-contents-created', (_evt, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
