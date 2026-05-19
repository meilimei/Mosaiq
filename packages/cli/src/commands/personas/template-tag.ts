/**
 * Persona ↔ template-id 的桥接。
 *
 * Persona schema 不持久化 template id（见 packages/persona-schema/src/persona.ts
 * 的注释）。Mosaiq 生态约定把它编码进 `metadata.tags`：
 *
 *   - **CLI 约定（Phase 9.5+）**：`template:<id>`，如 `template:win11-chrome-us`
 *   - **Desktop 历史约定**：tag 字面值 = template id，如 `win11-chrome-us`
 *     （见 `apps/desktop/electron/main.ts:getPersonaTemplate`）
 *
 * `extractTemplateTag` 先吃 CLI 前缀形态、再 fallback bare 形态，两边都能识别；
 * `makeTemplateTag` 在 CLI 创建 persona 时打上前缀 tag，让以后 list/show 能反查。
 *
 * 没匹配上 → undefined，调用方自渲染 fallback（如 'unknown'）。
 */

import { TEMPLATE_CATALOG } from '@mosaiq/persona-schema/templates';

export const TEMPLATE_TAG_PREFIX = 'template:';

/** 当前已知的模板 id 集合（与 TEMPLATE_CATALOG 同步）。 */
const KNOWN_TEMPLATE_IDS: ReadonlySet<string> = new Set(TEMPLATE_CATALOG.map((t) => t.id));

export interface PersonaLike {
  metadata: { tags?: readonly string[] };
}

export function extractTemplateTag(p: PersonaLike): string | undefined {
  const tags = p.metadata.tags ?? [];
  for (const tag of tags) {
    if (tag.startsWith(TEMPLATE_TAG_PREFIX)) {
      return tag.slice(TEMPLATE_TAG_PREFIX.length);
    }
  }
  for (const tag of tags) {
    if (KNOWN_TEMPLATE_IDS.has(tag)) return tag;
  }
  return undefined;
}

export function makeTemplateTag(templateId: string): string {
  return `${TEMPLATE_TAG_PREFIX}${templateId}`;
}
