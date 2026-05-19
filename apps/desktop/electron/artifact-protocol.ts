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
 * Pure validation + path resolution lives in `./artifact-protocol-core.ts`
 * so it can be unit-tested without an Electron runtime. This file glues
 * the core helpers to Electron's protocol API and to the SDK's path helper.
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
import { pathToFileURL } from 'node:url';

import { getDetectionRunArtifactDir } from '@mosaiq/sdk';
import { net, protocol } from 'electron';

import { SCHEME, extensionOf, mimeForExt, resolveArtifactPath } from './artifact-protocol-core.js';

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
    const result = resolveArtifactPath(url, getDetectionRunArtifactDir);
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
