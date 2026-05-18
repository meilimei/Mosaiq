/**
 * Persona 导入 / 导出工具。
 *
 * 用途：
 *   - 跨设备迁移（dev 机做完养号画像，导出到生产机）
 *   - 备份（提交到私有 git，团队共享）
 *   - 团队协作（一份 persona 模板分发给多人）
 *
 * 文件格式 = `Persona` schema 直接 JSON 序列化（同 persona-store.ts 写盘格式），
 * 所以一份导出的 `.json` 直接放进 `~/.mosaiq/personas/` 目录就能被 SDK 识别 ——
 * 这等价于一个对外的、稳定的、可手工编辑的「persona 互操作格式」。
 *
 * 安全提醒：
 *   - 导出**默认脱敏代理密码**（`stripSecrets: true`），避免不小心把凭据传到 IM /
 *     git 仓库。导入端必须在 UI 上重新填密码才能真正联网。
 *   - cookie / localStorage / IndexedDB 存在 chromium user-data-dir，**不在**
 *     persona JSON 里。导出 persona 不会带走会话。这是有意为之 —— 让用户清楚
 *     什么是身份配置（移植）vs 什么是登录状态（不移植）。
 */
import { type Persona, type PersonaId, parsePersona } from '@mosaiq/persona-schema';

import type { PathConfig } from './paths.js';
import { loadPersona, personaExists, savePersona } from './persona-store.js';

export interface ExportOptions {
  /**
   * 是否抹掉敏感字段（当前仅 `network.proxy.password`）。默认 true。
   *
   * 为什么不连同 username 一起脱敏：username 通常是 sticky-session 标签
   * （`brd-customer-XXX-zone-residential-session-001`），本身不算秘密，且
   * 缺它会让导入端没法识别要重连的代理桶。仅密码是真敏感字段。
   */
  stripSecrets?: boolean;
}

export interface ImportConflictOptions {
  /**
   * 当目标 ID 已存在时的策略：
   *   - `'error'`（默认）：抛错，让 UI 让用户决定
   *   - `'rename'`：自动加 `-imported` / `-imported-2` 后缀避免冲突
   *   - `'overwrite'`：覆盖磁盘文件（**注意**：会保留 chromium user-data-dir
   *     里的 cookie，但 persona 配置被替换 —— 用错可能导致指纹与 cookie 不一致）
   */
  onConflict?: 'error' | 'rename' | 'overwrite';
}

export type ImportOptions = ImportConflictOptions & PathConfig;

// ─────────────────────────────────────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 persona 对象序列化为 JSON 字符串（pretty-printed，2-space indent）。
 * 不读磁盘 —— 调用方传入已有的 Persona 对象。
 */
export function serializePersona(persona: Persona, opts: ExportOptions = {}): string {
  const stripSecrets = opts.stripSecrets ?? true;
  // structuredClone 走深拷贝，避免改外部对象
  const cloned = structuredClone(persona) as Persona;
  if (stripSecrets && cloned.network.proxy) {
    cloned.network.proxy = {
      ...cloned.network.proxy,
      password: '',
    };
  }
  return JSON.stringify(cloned, null, 2);
}

/**
 * 从磁盘读 persona 并序列化。便利封装 = `serializePersona(loadPersona(id))`。
 */
export function exportPersonaJson(
  personaId: PersonaId,
  opts: ExportOptions & PathConfig = {},
): string {
  const persona = loadPersona(personaId, opts);
  return serializePersona(persona, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// 导入
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析 JSON 字符串为 Persona 对象。会做完整 schema 校验。
 * 不写磁盘，只返回内存对象。调用方决定要不要 `savePersona`。
 *
 * 抛错：JSON 解析失败 / schema 校验失败。
 */
export function parsePersonaJson(json: string): Persona {
  const data: unknown = JSON.parse(json);
  return parsePersona(data);
}

/**
 * 从 JSON 字符串导入 persona 到磁盘。会处理 ID 冲突。
 *
 * 返回最终落盘的 persona —— 注意 `id` 可能因 `onConflict: 'rename'` 而变化，
 * UI 应使用返回值的 id 跳转到 edit / list 页面，而不是 incoming 的 id。
 *
 * 行为：
 *   - 解析 + schema 校验 incoming JSON
 *   - 检查 ID 冲突 → 按 onConflict 处理
 *   - savePersona 落盘（会刷新 metadata.updatedAt）
 *
 * 抛错：
 *   - JSON 解析失败 / schema 校验失败
 *   - onConflict='error' 且 ID 冲突
 *   - onConflict='rename' 但生成的候选 ID 仍冲突（极端情况，>10000 次冲突）
 */
export function importPersonaJson(json: string, opts: ImportOptions = {}): Persona {
  const incoming = parsePersonaJson(json);
  const onConflict = opts.onConflict ?? 'error';

  let finalId: PersonaId = incoming.metadata.id;

  if (personaExists(finalId, opts)) {
    switch (onConflict) {
      case 'error':
        throw new Error(
          `Persona id "${finalId}" already exists. Specify { onConflict: 'rename' | 'overwrite' } to override.`,
        );
      case 'rename': {
        finalId = generateUniqueId(incoming.metadata.id, opts);
        break;
      }
      case 'overwrite':
        // 保持 finalId = incoming.id，savePersona 会覆盖
        break;
    }
  }

  // 重置启动统计 —— 导入到新设备时旧的 launchCount / lastLaunchedAt 没意义
  // （在新设备上是 fresh 启动）。但保留 createdAt 让用户知道画像血统。
  const now = new Date().toISOString();
  const final: Persona = {
    ...incoming,
    metadata: {
      ...incoming.metadata,
      id: finalId,
      lastLaunchedAt: null,
      launchCount: 0,
      updatedAt: now,
    },
  };

  return savePersona(final, opts);
}

/**
 * 在冲突时生成不冲突的新 ID：`<base>-imported` → `<base>-imported-2` → ...
 *
 * 上限 10000 次循环，正常用户永远碰不到，但守住极端情况防死循环。
 */
function generateUniqueId(base: PersonaId, opts: PathConfig): PersonaId {
  const candidate1 = `${base}-imported` as PersonaId;
  if (!personaExists(candidate1, opts)) return candidate1;
  for (let i = 2; i < 10000; i++) {
    const c = `${base}-imported-${i}` as PersonaId;
    if (!personaExists(c, opts)) return c;
  }
  throw new Error(`Could not generate unique id from base "${base}" after 10000 attempts`);
}
