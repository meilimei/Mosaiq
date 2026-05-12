/**
 * Electron 主进程。
 *   - 创建窗口
 *   - 注册 IPC handlers（直接调用 @mosaiq/sdk）
 *   - 跟踪每个 persona 的运行中 session
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { BrowserWindow, app, dialog, ipcMain } from 'electron';

import type { Persona, PersonaId } from '@mosaiq/persona-schema';
import {
  createMacosSonomaChromeUsPersona,
  createUbuntu2204ChromeUsPersona,
  createWin10ChromeUsPersona,
  createWin11ChromeUsPersona,
} from '@mosaiq/persona-schema/templates';
import {
  type BrowserSession,
  exportPersonaJson,
  importPersonaJson,
  loadPersona,
  personaExists,
  recordLaunch,
  savePersona,
  clonePersona as sdkClonePersona,
  deletePersona as sdkDeletePersona,
  launchPersona as sdkLaunchPersona,
  listPersonas as sdkListPersonas,
  updatePersona as sdkUpdatePersona,
  verifyProxy,
} from '@mosaiq/sdk';

import {
  type ClonePersonaInput,
  type CreatePersonaInput,
  type ExportPersonaOptions,
  type ExportPersonaResult,
  IPC_CHANNELS,
  type ImportPersonaResult,
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

function buildSummary(
  personaId: PersonaId,
  persona: ReturnType<typeof loadPersona>,
): PersonaSummary {
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
    let persona: Persona;
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
      case 'win10-chrome-us':
        persona = createWin10ChromeUsPersona({
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
      case 'ubuntu-2204-chrome-us':
        persona = createUbuntu2204ChromeUsPersona({
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

  ipcMain.handle(
    IPC_CHANNELS.exportPersona,
    async (_evt, id: PersonaId, opts: ExportPersonaOptions): Promise<ExportPersonaResult> => {
      try {
        // 先序列化（验证 persona 存在 + schema 合法），再弹 dialog；这样如果
        // persona 已损坏，用户不会先看到 dialog 然后才报错
        const json = exportPersonaJson(id, { stripSecrets: opts.stripSecrets ?? true });
        if (!mainWindow) {
          return { ok: false, error: 'Main window not available' };
        }
        const result = await dialog.showSaveDialog(mainWindow, {
          title: '导出 Persona',
          defaultPath: `${id}.json`,
          filters: [{ name: 'Mosaiq Persona', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) {
          return { ok: false, canceled: true };
        }
        writeFileSync(result.filePath, json, 'utf-8');
        return { ok: true, savedTo: result.filePath };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.importPersona, async (): Promise<ImportPersonaResult> => {
    if (!mainWindow) {
      return { ok: false, error: 'Main window not available' };
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 Persona',
      properties: ['openFile'],
      filters: [{ name: 'Mosaiq Persona', extensions: ['json'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    try {
      const filePath = result.filePaths[0];
      if (!filePath) {
        return { ok: false, error: '未选中文件' };
      }
      const json = readFileSync(filePath, 'utf-8');
      // 提前 peek incoming id 用于决定是否会发生 rename，告诉前端原 id 便于显示
      // 弱解析（不抛错），最坏情况是 incomingId === undefined 导致 renamedFrom
      // 不展示，但导入主流程仍由 importPersonaJson 严格校验
      let incomingId: PersonaId | undefined;
      try {
        const peek = JSON.parse(json) as { metadata?: { id?: string } };
        incomingId = peek.metadata?.id as PersonaId | undefined;
      } catch {
        // 落到下面的 importPersonaJson 抛 schema 错
      }
      const willRename = incomingId ? personaExists(incomingId as PersonaId) : false;
      // 默认 'rename' 策略：永远不破坏现有 persona / cookie，最安全的默认
      const persona = importPersonaJson(json, { onConflict: 'rename' });
      return {
        ok: true,
        persona: buildSummary(persona.metadata.id, persona),
        renamedFrom: willRename ? incomingId : undefined,
      };
    } catch (err) {
      // 给用户一些上下文：是哪个文件出问题
      const fileName = result.filePaths[0] ? basename(result.filePaths[0]) : '未知文件';
      return { ok: false, error: `${fileName}: ${(err as Error).message}` };
    }
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
