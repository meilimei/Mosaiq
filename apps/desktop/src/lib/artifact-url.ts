/**
 * Build URLs for the `mosaiq-artifact://` protocol registered in the Electron
 * main process (`apps/desktop/electron/artifact-protocol.ts`).
 *
 * URL shape:
 *   mosaiq-artifact://<personaId>/<runId>/<filename>
 *
 * `SiteResult.screenshot` / `SiteResult.html` from `@mosaiq/sdk` are stored
 * as **relative paths** to the run's artifact dir — typically just
 * "<siteId>.png" / "<siteId>.html". This helper turns one of those relative
 * paths into a URL the renderer can drop directly into `<img src="">`.
 *
 * The main-process handler enforces:
 *   - extension allowlist (png/jpg/jpeg/webp/html)
 *   - id-syntax: [A-Za-z0-9._-]+ (no slashes / `..` / null bytes)
 *   - resolved path stays inside the run's artifact dir
 *
 * So the renderer side just has to encode and concatenate.
 */

import type { PersonaId } from '@mosaiq/persona-schema';

const SCHEME = 'mosaiq-artifact';

export function buildArtifactUrl(
  personaId: PersonaId,
  runId: string,
  relativePath: string,
): string {
  // Normalize backslashes that may sneak in on Windows-stored relative paths.
  // SiteResult.screenshot is generally just "<siteId>.png" so this is mostly
  // defensive — but it lets us tolerate "subdir/file.png" if the SDK ever
  // grows nested artifacts (the protocol handler will then reject because
  // it requires exactly one path segment after the runId; that's intentional
  // for v0.9 phase 9.3 — flat layout only).
  const filename = relativePath.replace(/\\/g, '/');
  return (
    `${SCHEME}://${encodeURIComponent(personaId)}` +
    `/${encodeURIComponent(runId)}` +
    `/${encodeURIComponent(filename)}`
  );
}
