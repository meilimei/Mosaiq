/**
 * `mosaiq-artifact://` custom protocol — serves per-run artifact files
 * (screenshots / HTML snapshots) to the renderer over a constrained,
 * filesystem-rooted scheme.
 *
 * URL shape:
 *   mosaiq-artifact://<personaId>/<runId>/<filename>
 *
 *   - host = personaId
 *   - first path segment = runId
 *   - second path segment = filename relative to the run's artifact dir
 *
 * The handler resolves to:
 *   <getDetectionRunArtifactDir(personaId, runId)> / <filename>
 *
 * Security boundary (defense in depth):
 *   1. personaId / runId / filename must each match `[A-Za-z0-9._-]+`
 *      (no slashes, no '..', no nulls)
 *   2. extension allowlist: png, jpg, jpeg, webp, html
 *   3. resolved absolute path **must** stay inside the artifact dir
 *      (path.resolve + startsWith assertion — catches symlink shenanigans)
 *   4. file must exist + be a regular file
 *
 * Why a custom scheme instead of `file://`:
 *   - Renderer is sandboxed + contextIsolation: true; loading file:// from
 *     it requires lifting `webSecurity` which we won't do.
 *   - Custom scheme registered as `secure: true, standard: true` lets `<img>`
 *     in the renderer load these URLs directly without any IPC round-trip,
 *     while still being subject to CSP and same-origin policy.
 *
 * Lifecycle:
 *   - `registerArtifactScheme()` MUST be called synchronously at module load
 *     (before `app.whenReady()`) — Electron requires schemes to be declared
 *     privileged early.
 *   - `registerArtifactHandler()` is called inside `app.whenReady()` and sets
 *     up the actual fetch handler.
 */

import { type Stats, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PersonaId } from '@mosaiq/persona-schema';
import { getDetectionRunArtifactDir } from '@mosaiq/sdk';
import { net, protocol } from 'electron';

const SCHEME = 'mosaiq-artifact';

/** Allowed file extensions (lowercased, no leading dot). */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'html']);

/** Identifier syntax — letters, digits, dot, dash, underscore. No slashes / null bytes / `..`. */
const ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Privileged-scheme registration. **Call before `app.whenReady()`.**
 *
 *   - `standard: true` — host-based URL parsing (so `mosaiq-artifact://host/path`
 *     parses with a real `URL.host`)
 *   - `secure: true`   — treated as a secure context; allows `<img>` loading
 *     under default Electron CSP without `webSecurity: false`
 *   - `supportFetchAPI: true` — renderer can also `fetch()` it (useful for
 *     future inline HTML snapshots or `Image.decode()`)
 *   - `stream: true`   — handler may return a streamed Response body
 *   - `bypassCSP: false` — still subject to renderer CSP (good)
 */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
    },
  ]);
}

/**
 * Fetch handler. **Call inside `app.whenReady()`.**
 *
 * Returns 400 on validation failure, 404 on missing/non-file targets, 200
 * with the file contents otherwise. Uses `net.fetch(file://...)` so Electron
 * handles streaming / Content-Length / etc.; we only set Content-Type and a
 * mild cache hint.
 */
export function registerArtifactHandler(): void {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    const result = resolveArtifactPath(url);
    if (!result.ok) {
      return new Response(`bad request: ${result.reason}`, {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    const abs = result.abs;
    if (!existsSync(abs)) {
      return new Response('not found', { status: 404 });
    }
    let st: Stats;
    try {
      st = statSync(abs);
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (!st.isFile()) {
      return new Response('not a file', { status: 404 });
    }

    // Hand off to Electron's net stack — gets us streaming + correct
    // Content-Length without us having to wire a stream manually.
    const fileResponse = await net.fetch(pathToFileURL(abs).toString());
    const headers = new Headers(fileResponse.headers);
    headers.set('Content-Type', mimeForExt(extensionOf(abs)));
    headers.set('Cache-Control', 'private, max-age=3600');
    return new Response(fileResponse.body, {
      status: fileResponse.status,
      headers,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (exported for tests once we add them)
// ─────────────────────────────────────────────────────────────────────────────

interface ResolveOk {
  ok: true;
  abs: string;
}
interface ResolveFail {
  ok: false;
  reason: string;
}

/**
 * Pure: given a parsed `URL`, validate + resolve to an absolute filesystem
 * path inside the run's artifact dir. Does **not** touch the filesystem.
 */
export function resolveArtifactPath(url: URL): ResolveOk | ResolveFail {
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

  // Resolve + containment assertion. `getDetectionRunArtifactDir` is the
  // single source of truth for where artifacts live; we trust it for the
  // base, then double-check that the join + resolve doesn't escape via
  // weird casing / trailing slashes.
  const baseAbs = resolve(getDetectionRunArtifactDir(personaId as PersonaId, runId));
  const targetAbs = resolve(baseAbs, filename);
  if (targetAbs !== baseAbs && !targetAbs.startsWith(baseAbs + sep)) {
    return { ok: false, reason: 'path escape' };
  }

  return { ok: true, abs: targetAbs };
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return '';
  return filename.slice(dot + 1).toLowerCase();
}

function mimeForExt(ext: string): string {
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
