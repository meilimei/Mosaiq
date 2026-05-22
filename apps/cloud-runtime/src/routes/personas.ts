/**
 * /v1/personas CRUD。
 *
 * v0.11 phase 11.1 只支持 user-uploaded persona：
 *   POST /v1/personas         —— 上传一个 persona（per project）
 *   GET  /v1/personas         —— 列出当前 project 的 + 全局可见的 seed
 *   GET  /v1/personas/:id     —— 详情
 *   DELETE /v1/personas/:id   —— 删除（仅 user-source）
 *
 * Seed pool / capture 路径在 phase 11.4 上。
 */

import { Hono } from 'hono';
import { and, eq, isNull, or } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { personas as personasTable } from '../db/schema.js';
import { audit } from '../middleware/audit.js';
import { getAuth } from '../middleware/auth.js';
import { ApiError } from '../utils/errors.js';
import { parsePersona, type Persona } from '@mosaiq/persona-schema';

export const personasRoute = new Hono();

// ─── POST /v1/personas ─────────────────────────────────────────────────────

personasRoute.post('/', async (c) => {
  const auth = getAuth(c);
  const body = await c.req.json().catch(() => null);
  let persona: Persona;
  try {
    persona = parsePersona(body);
  } catch (err) {
    audit(c, 'persona.create', 'persona:?', 'errored');
    throw new ApiError(
      'request.invalid',
      `persona failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const handle = await getDb();
  // persona id 来自 metadata.id，跟 desktop 行为一致
  const id = persona.metadata.id;

  const dup = await handle.drizzle
    .select({ id: personasTable.id })
    .from(personasTable)
    .where(and(eq(personasTable.id, id), eq(personasTable.projectId, auth.projectId)))
    .limit(1);
  if (dup.length > 0) {
    audit(c, 'persona.create', `persona:${id}`, 'errored', { reason: 'duplicate' });
    throw new ApiError('persona.duplicate', `persona ${id} already exists in this project`);
  }

  await handle.drizzle.insert(personasTable).values({
    id,
    projectId: auth.projectId,
    source: 'user',
    personaJson: JSON.stringify(persona),
  });
  audit(c, 'persona.create', `persona:${id}`, 'ok');
  return c.json({ id, source: 'user', project_id: auth.projectId }, 201);
});

// ─── GET /v1/personas ──────────────────────────────────────────────────────

personasRoute.get('/', async (c) => {
  const auth = getAuth(c);
  const handle = await getDb();
  const rows = await handle.drizzle
    .select({
      id: personasTable.id,
      source: personasTable.source,
      projectId: personasTable.projectId,
      createdAt: personasTable.createdAt,
      updatedAt: personasTable.updatedAt,
    })
    .from(personasTable)
    .where(or(eq(personasTable.projectId, auth.projectId), isNull(personasTable.projectId)));
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      source: r.source,
      project_id: r.projectId,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    })),
  });
});

// ─── GET /v1/personas/:id ──────────────────────────────────────────────────

personasRoute.get('/:id', async (c) => {
  const auth = getAuth(c);
  const id = c.req.param('id');
  const handle = await getDb();
  const rows = await handle.drizzle
    .select()
    .from(personasTable)
    .where(
      and(
        eq(personasTable.id, id),
        or(eq(personasTable.projectId, auth.projectId), isNull(personasTable.projectId)),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiError('persona.not_found', `persona ${id} not found`);

  let persona: Persona;
  try {
    persona = parsePersona(JSON.parse(row.personaJson));
  } catch (err) {
    throw new ApiError(
      'internal.unknown',
      `stored persona ${id} failed re-parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return c.json({
    id: row.id,
    source: row.source,
    project_id: row.projectId,
    persona,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
});

// ─── DELETE /v1/personas/:id ───────────────────────────────────────────────

personasRoute.delete('/:id', async (c) => {
  const auth = getAuth(c);
  const id = c.req.param('id');
  const handle = await getDb();
  const rows = await handle.drizzle
    .select({ source: personasTable.source, projectId: personasTable.projectId })
    .from(personasTable)
    .where(eq(personasTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    audit(c, 'persona.delete', `persona:${id}`, 'ok', { idempotent: true });
    return c.body(null, 204);
  }
  if (row.source !== 'user') {
    audit(c, 'persona.delete', `persona:${id}`, 'denied', { source: row.source });
    throw new ApiError('request.invalid', 'cannot delete non-user-source persona', {
      source: row.source,
    });
  }
  if (row.projectId !== auth.projectId) {
    audit(c, 'persona.delete', `persona:${id}`, 'denied', { reason: 'project_mismatch' });
    throw new ApiError('auth.project_mismatch', 'persona belongs to a different project');
  }
  await handle.drizzle.delete(personasTable).where(eq(personasTable.id, id));
  audit(c, 'persona.delete', `persona:${id}`, 'ok');
  return c.body(null, 204);
});
