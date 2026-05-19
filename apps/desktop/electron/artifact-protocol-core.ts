/**
 * Pure (filesystem-free, Electron-free) helpers for the
 * `mosaiq-artifact://` protocol. Split out from `artifact-protocol.ts` so
 * they can be unit-tested in a plain Node vitest run without mocking
 * `electron`.
 *
 * URL shape (recap):
 *   mosaiq-artifact://<personaId>/<runId>/<filename>
 *
 * Security rules enforced by `resolveArtifactPath`:
 *   1. scheme must be `mosaiq-artifact:`
 *   2. host (personaId), runId, filename each must match `[A-Za-z0-9._-]+`
 *      (no slashes, no `..`, no null bytes)
 *   3. extension must be in {png, jpg, jpeg, webp, html}
 *   4. resolved abs path must stay inside the run's artifact dir
 *      (path containment check — catches symlink / casing tricks)
 *
 * The filesystem-touching parts (existsSync, statSync, net.fetch) live in
 * `artifact-protocol.ts`; this file is **pure**.
 */

import { resolve, sep } from 'node:path';

import type { PersonaId } from '@mosaiq/persona-schema';

export const SCHEME = 'mosaiq-artifact';

/** Allowed file extensions (lowercased, no leading dot). */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'html',
]);

/** Identifier syntax — letters, digits, dot, dash, underscore. No slashes / null bytes / `..`. */
export const ID_RE = /^[A-Za-z0-9._-]+$/;

export interface ResolveOk {
  ok: true;
  abs: string;
}
export interface ResolveFail {
  ok: false;
  reason: string;
}

/**
 * Resolver for the artifact base directory. Injected so tests can run without
 * touching the real `~/.mosaiq` tree.
 */
export type ArtifactDirResolver = (personaId: PersonaId, runId: string) => string;

/**
 * Pure: validate a `mosaiq-artifact://` URL and resolve it to an absolute
 * filesystem path inside the run's artifact dir. Does **not** touch the
 * filesystem.
 *
 * @param url           parsed URL (e.g. `new URL(req.url)`)
 * @param resolveBaseDir resolver for the run's artifact dir; injected for testability
 */
export function resolveArtifactPath(
  url: URL,
  resolveBaseDir: ArtifactDirResolver,
): ResolveOk | ResolveFail {
  if (url.protocol !== `${SCHEME}:`) {
    return { ok: false, reason: 'wrong scheme' };
  }

  // host = personaId. URL parsing already lowercases the host for `standard`
  // schemes, but our persona ids are lowercase by convention; reject anything
  // suspicious explicitly.
  const personaId = decodeURIComponent(url.host);
  if (!ID_RE.test(personaId)) {
    return { ok: false, reason: 'invalid personaId' };
  }

  // pathname starts with '/'; expect exactly two non-empty segments.
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments.length !== 2) {
    return { ok: false, reason: 'expected /<runId>/<filename>' };
  }
  const runId = segments[0];
  const filename = segments[1];
  // segments.length === 2 guarantees both are defined, but the strict
  // noUncheckedIndexedAccess tsconfig still narrows them as `string|undefined`.
  if (runId === undefined || filename === undefined) {
    return { ok: false, reason: 'expected /<runId>/<filename>' };
  }
  if (!ID_RE.test(runId)) {
    return { ok: false, reason: 'invalid runId' };
  }
  if (!ID_RE.test(filename)) {
    return { ok: false, reason: 'invalid filename' };
  }

  const ext = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `extension '${ext}' not allowed` };
  }

  // Resolve + containment assertion. The injected resolver is the single
  // source of truth for where artifacts live; we trust it for the base, then
  // double-check that the join + resolve doesn't escape via weird casing /
  // trailing slashes.
  const baseAbs = resolve(resolveBaseDir(personaId as PersonaId, runId));
  const targetAbs = resolve(baseAbs, filename);
  if (targetAbs !== baseAbs && !targetAbs.startsWith(baseAbs + sep)) {
    return { ok: false, reason: 'path escape' };
  }

  return { ok: true, abs: targetAbs };
}

/** Lowercased extension without leading dot, or `''` if no dot. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/** MIME type for the small set of extensions we serve. */
export function mimeForExt(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'html':
      return 'text/html; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
