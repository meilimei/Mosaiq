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
  type DetectionRun,
  type DetectionRunRaw,
  type DetectionScore,
  type RunProgressEvent,
  type RunStatus,
  SDK_VERSION,
  deleteDetectionRun,
  exportPersonaJson,
  formatDetectionRunMarkdown,
  getDetectionRunArtifactDir,
  getInstalledChromeVersion,
  importPersonaJson,
  listDetectionRuns,
  loadDetectionRun,
  loadPersona,
  personaExists,
  recordLaunch,
  runDetection,
  saveDetectionRun,
  savePersona,
  clonePersona as sdkClonePersona,
  deletePersona as sdkDeletePersona,
  launchPersona as sdkLaunchPersona,
  listPersonas as sdkListPersonas,
  updatePersona as sdkUpdatePersona,
  verifyProxy,
} from '@mosaiq/sdk';

import { registerArtifactHandler, registerArtifactScheme } from './artifact-protocol.js';
import {
  type ClonePersonaInput,
  type CreatePersonaInput,
  type DetectionLabProgressMessage,
  type DetectionRunStartResult,
  type ExportPersonaOptions,
  type ExportPersonaResult,
  type ExportRunMarkdownOptions,
  type ExportRunMarkdownResult,
  IPC_CHANNELS,
  IPC_EVENTS,
  type ImportPersonaResult,
  type PersonaSummary,
  type ProxyVerifyInput,
  type UpdatePersonaInput,
} from './ipc-types.js';

// v0.9 phase 9.3: register the `mosaiq-artifact://` scheme as privileged
// **before** `app.whenReady()` resolves — Electron requires privileged
// schemes to be declared early in the process lifecycle so renderer
// `<img>` tags can load them under default CSP.
registerArtifactScheme();

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

// ─────────────────────────────────────────────────────────────────────────────
// Detection Lab — in-flight run 注册表
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 当前在跑的 detection run。**约束：单 persona 串行**——同一 personaId 只能
 * 有一个 in-flight run，第二次启动同步返回错误（避免两套 Playwright 抢同一个
 * user-data-dir）。键设计成 `PersonaId` 而非 `runId` 就是为了 O(1) 命中此约束。
 *
 * `cancel` 路径需要按 `runId` 查找——`activeRunsByRunId` 是反向索引。
 *
 * Phase 8.5 选择 fire-and-forget：启动 IPC 同步返回 runId 之后 detection 异步
 * 跑，进度走 `IPC_EVENTS.detectionLabProgress`。promise 收在 `activeRunPromises`
 * 里，window-all-closed 时统一 abort（不 await，避免 60s page.goto 卡住关窗）。
 */
interface ActiveRunEntry {
  runId: string;
  personaId: PersonaId;
  abort: AbortController;
  startedAt: string;
  startedAtMs: number;
}

const activeRuns = new Map<PersonaId, ActiveRunEntry>();
const activeRunsByRunId = new Map<string, ActiveRunEntry>();

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
// Detection Lab — helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 容错读 chromium 版本（chromium 没装时 SDK 也会扔，但保 detection 失败路径能写盘）。 */
function safeChromiumVersion(): string | undefined {
  try {
    return getInstalledChromeVersion();
  } catch {
    return undefined;
  }
}

/**
 * SDK 的 progress 事件分两类：
 *   - **中间态**（init / site-start / site-end / site-retry）— main 直接透传
 *   - **终态**（done / canceled / error）— main 不透传 SDK 自己发的；改由 main
 *     在 `await runDetection` 返回 / 抛错后构造 `DetectionRun` 并自己 emit 带
 *     `finalRun` 字段的终态，让 renderer 收到唯一一个终态事件。
 *
 * 这么做的动机：SDK 的 done 不知道 `DetectionRun.startedAt / finishedAt / meta`，
 * 也不能 `saveDetectionRun`（SDK 不该依赖 storage 决定持久化路径）；这些是 main
 * 的责任。统一在 main 这层 finalize 让进度流更干净。
 */
const FORWARD_PHASES: ReadonlySet<RunProgressEvent['phase']> = new Set([
  'init',
  'site-start',
  'site-end',
  'site-retry',
]);

function emitProgress(runId: string, progress: RunProgressEvent): void {
  const msg: DetectionLabProgressMessage = { runId, progress };
  mainWindow?.webContents.send(IPC_EVENTS.detectionLabProgress, msg);
}

function buildCompletedRun(
  runId: string,
  entry: ActiveRunEntry,
  raw: DetectionRunRaw,
  score: DetectionScore,
  status: 'completed' | 'canceled',
): DetectionRun {
  return {
    id: runId,
    personaId: entry.personaId,
    startedAt: entry.startedAt,
    finishedAt: new Date().toISOString(),
    status,
    sitesAttempted: raw.results.map((r) => r.id),
    durationMs: Date.now() - entry.startedAtMs,
    score,
    raw,
    error: null,
    meta: {
      sdkVersion: SDK_VERSION,
      chromiumVersion: safeChromiumVersion(),
    },
  };
}

function buildFailedRun(runId: string, entry: ActiveRunEntry, error: string): DetectionRun {
  return {
    id: runId,
    personaId: entry.personaId,
    startedAt: entry.startedAt,
    finishedAt: new Date().toISOString(),
    status: 'failed',
    sitesAttempted: [],
    durationMs: Date.now() - entry.startedAtMs,
    score: null,
    error,
    meta: {
      sdkVersion: SDK_VERSION,
      chromiumVersion: safeChromiumVersion(),
    },
  };
}

/** 终态 phase 字符串映射：RunStatus → progress phase。 */
function statusToTerminalPhase(status: RunStatus): RunProgressEvent['phase'] {
  if (status === 'completed') return 'done';
  if (status === 'canceled') return 'canceled';
  return 'error';
}

/**
 * Fire-and-forget 跑一次 detection run。
 *
 * 控制流：
 *   1. await runDetection（中间 progress 透传，SDK 的终态被 FORWARD_PHASES 过滤掉）
 *   2. 检查 abort.signal 决定 status: completed | canceled（runDetection 自身 abort 不抛）
 *   3. saveDetectionRun + emit 自己的终态事件（带 finalRun）
 *   4. catch: launch 失败 / 不可恢复异常 → status=failed
 *   5. finally: activeRuns.delete + activeRunsByRunId.delete
 *
 * 不 await 此函数本身——调用方拿到 promise 后丢进 activeRunPromises，window-all-
 * closed 时统一 abort（不强求等完，进程会被强杀）。
 */
async function executeDetectionRunAsync(entry: ActiveRunEntry, persona: Persona): Promise<void> {
  const { runId, personaId, abort } = entry;
  try {
    const result = await runDetection(persona, {
      runId,
      personaTemplate: getPersonaTemplate(persona),
      signal: abort.signal,
      artifactDir: getDetectionRunArtifactDir(personaId, runId),
      launchOptions: { headless: true },
      onProgress: (evt) => {
        if (FORWARD_PHASES.has(evt.phase)) {
          emitProgress(runId, evt);
        }
      },
    });
    const status: RunStatus = abort.signal.aborted ? 'canceled' : 'completed';
    const run = buildCompletedRun(runId, entry, result.raw, result.score, status);
    saveDetectionRun(personaId, run);
    emitProgress(runId, {
      runId,
      personaId,
      phase: statusToTerminalPhase(status),
      finalRun: run,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const run = buildFailedRun(runId, entry, message);
    try {
      saveDetectionRun(personaId, run);
    } catch (saveErr) {
      // 保存失败本身不冒泡——detection 已经失败，让 renderer 拿到 error event
      // 比"沉默崩溃"重要。saveErr 落日志即可。
      console.error('[mosaiq] saveDetectionRun on failed run also failed:', saveErr);
    }
    emitProgress(runId, {
      runId,
      personaId,
      phase: 'error',
      error: message,
      finalRun: run,
    });
  } finally {
    activeRuns.delete(personaId);
    activeRunsByRunId.delete(runId);
  }
}

/**
 * Persona 不在 schema 里持久化 template id（创建时 caller 传入 win11-chrome-us 之类）。
 * 这里反推：tags 里如果有 known template id，作为 best-effort 的 metadata 注入；
 * 否则填 'unknown'。失败不影响 detection 结果，只是 `raw.persona.template` 不
 * informative。
 */
function getPersonaTemplate(persona: Persona): string {
  const knownTemplates = [
    'win11-chrome-us',
    'win10-chrome-us',
    'macos-sonoma-chrome-us',
    'ubuntu-2204-chrome-us',
  ];
  const tag = persona.metadata.tags.find((t) => knownTemplates.includes(t));
  return tag ?? 'unknown';
}

/** ISO timestamp folder-safe（替换 `:` / `.` 为 `-`），与 bench 时间戳同风格。 */
function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
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
        mainWindow?.webContents.send(IPC_EVENTS.personaStopped, id);
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

  // ── Phase 8.5 Detection Lab ──────────────────────────────────────────────

  /**
   * 启动一次 detection run（fire-and-forget）。
   *
   * 守卫顺序：
   *   1. persona 存在 → 不存在直接 ok:false
   *   2. 该 persona 没有 in-flight run → 有则 ok:false（单 persona 串行约束）
   *
   * 通过后：生成 runId、注册到 activeRuns 双索引、kick off async run、立刻返回。
   * Renderer 拿到 runId 后订阅 `onDetectionLabProgress` 接收进度。
   */
  ipcMain.handle(
    IPC_CHANNELS.detectionLabRun,
    (_evt, personaId: PersonaId): DetectionRunStartResult => {
      if (!personaExists(personaId)) {
        return { ok: false, error: `Persona not found: ${personaId}` };
      }
      const existing = activeRuns.get(personaId);
      if (existing) {
        return {
          ok: false,
          error: `Persona ${personaId} already has an in-flight run (${existing.runId}). Cancel it first or wait.`,
        };
      }

      let persona: Persona;
      try {
        persona = loadPersona(personaId);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }

      const runId = newRunId();
      const startedAtMs = Date.now();
      const entry: ActiveRunEntry = {
        runId,
        personaId,
        abort: new AbortController(),
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
      };
      activeRuns.set(personaId, entry);
      activeRunsByRunId.set(runId, entry);

      // Fire-and-forget。`void` 标记给 TS / lint 看：故意不 await。错误兜底
      // 全部走 executeDetectionRunAsync 内部 catch + saveDetectionRun + emit error。
      void executeDetectionRunAsync(entry, persona);

      return { ok: true, runId };
    },
  );

  /** 中断 in-flight run；abort 后 SDK 会让当前站结束（goto timeout 内），下站起短路。 */
  ipcMain.handle(IPC_CHANNELS.detectionLabCancel, (_evt, runId: string): boolean => {
    const entry = activeRunsByRunId.get(runId);
    if (!entry) return false;
    entry.abort.abort();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.detectionLabListRuns, (_evt, personaId: PersonaId) => {
    return listDetectionRuns(personaId);
  });

  ipcMain.handle(
    IPC_CHANNELS.detectionLabGetRun,
    (_evt, personaId: PersonaId, runId: string): DetectionRun => {
      return loadDetectionRun(personaId, runId);
    },
  );

  /**
   * 删除一次 run（含 artifacts 子目录）。
   *
   * 不允许删 in-flight run——会把还在写的文件删了 / artifact 子目录被占用 rm 失败。
   * Renderer 如果想删 in-flight，应先 cancel 等终态事件，再删。
   */
  ipcMain.handle(
    IPC_CHANNELS.detectionLabDeleteRun,
    (_evt, personaId: PersonaId, runId: string): boolean => {
      if (activeRunsByRunId.has(runId)) {
        throw new Error(`Cannot delete in-flight run ${runId}; cancel it first then retry.`);
      }
      return deleteDetectionRun(personaId, runId);
    },
  );

  /**
   * v0.9 phase 9.7: 导出 detection run 为 markdown 报告。
   *
   * 流程（与 exportPersona 同设计）：
   *   1. 先 load + format（验证 run 文件存在 + 渲染成功），有问题立即返回 error；
   *      这样如果 run 已损坏，用户不会先看到 dialog 然后才报错。
   *   2. 弹 save dialog，默认文件名 `<personaId>-<runId>.md`，filter 限 .md。
   *   3. 用户取消 → canceled:true；选定 → 写盘 → ok:true。
   *   4. 任何 throw → error:string。
   *
   * 不复用 CLI 的 exit-2-on-failed-write 行为；桌面统一走 toast，不抛 throw 让
   * preload bridge 屏蔽出 IPC（renderer 看到 reject 反而难处理）。
   */
  ipcMain.handle(
    IPC_CHANNELS.detectionLabExportRunMarkdown,
    async (
      _evt,
      personaId: PersonaId,
      runId: string,
      opts: ExportRunMarkdownOptions,
    ): Promise<ExportRunMarkdownResult> => {
      try {
        const run = loadDetectionRun(personaId, runId);
        // SDK formatter 默认全部包含；只在 opts 显式给 false 时收窄
        const markdown = `${formatDetectionRunMarkdown(run, {
          includeSiteDetails: opts.includeSiteDetails,
          includeHits: opts.includeHits,
          includeMeta: opts.includeMeta,
        })}\n`;
        if (!mainWindow) {
          return { ok: false, error: 'Main window not available' };
        }
        const result = await dialog.showSaveDialog(mainWindow, {
          title: '导出 Detection Run（Markdown）',
          defaultPath: `${personaId}-${runId}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (result.canceled || !result.filePath) {
          return { ok: false, canceled: true };
        }
        writeFileSync(result.filePath, markdown, 'utf-8');
        return { ok: true, savedTo: result.filePath };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  registerArtifactHandler();
  registerIpcHandlers();
  await createWindow();
});

app.on('window-all-closed', async () => {
  // 中断所有 in-flight detection run。Fire-and-forget 的 saveDetectionRun 可能
  // 来不及完成——这是可接受的：listDetectionRuns 看到坏 JSON 会 warn skip，下次
  // run 不受影响。强行 await 这些 promise 会让关窗体验差（最坏 60s page.goto）。
  for (const [, entry] of activeRuns) {
    entry.abort.abort();
  }
  activeRuns.clear();
  activeRunsByRunId.clear();

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
