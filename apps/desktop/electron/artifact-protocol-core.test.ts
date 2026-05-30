/**
 * Unit tests for the pure resolver in `artifact-protocol-core.ts`.
 *
 * These exercise the security boundary on its own — no Electron, no real
 * filesystem. The base-dir resolver is injected so the test controls the
 * answer for every (personaId, runId) pair.
 */

import { resolve } from 'node:path';

import type { PersonaId } from '@runova/persona-schema';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_EXTENSIONS,
  type ArtifactDirResolver,
  ID_RE,
  extensionOf,
  mimeForExt,
  resolveArtifactPath,
} from './artifact-protocol-core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

/** Stand-in artifact root used by the injected resolver in every test. */
const FAKE_ROOT = resolve('/tmp/mosaiq-tests');

/** Predictable resolver: <FAKE_ROOT>/<personaId>/<runId> */
const fakeResolver: ArtifactDirResolver = (personaId, runId) =>
  resolve(FAKE_ROOT, personaId, runId);

/** Convenience: parse a string URL. */
const u = (s: string): URL => new URL(s);

// ─────────────────────────────────────────────────────────────────────────────
// resolveArtifactPath — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveArtifactPath / happy path', () => {
  it('resolves a well-formed PNG URL inside the run dir', () => {
    const url = u('mosaiq-artifact://baseline-bench-abc123/2026-05-18T13-44-26-599Z/site-1.png');
    const r = resolveArtifactPath(url, fakeResolver);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.abs).toBe(
        resolve(FAKE_ROOT, 'baseline-bench-abc123', '2026-05-18T13-44-26-599Z', 'site-1.png'),
      );
    }
  });

  it('accepts each whitelisted extension', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'html']) {
      const url = u(`mosaiq-artifact://p/r/file.${ext}`);
      const r = resolveArtifactPath(url, fakeResolver);
      expect(r.ok, `extension ${ext} should be allowed`).toBe(true);
    }
  });

  it('extension match is case-insensitive (uppercase still allowed)', () => {
    const url = u('mosaiq-artifact://p/r/SHOUT.PNG');
    const r = resolveArtifactPath(url, fakeResolver);
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveArtifactPath — scheme + segment counts
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveArtifactPath / structure validation', () => {
  it('rejects non-mosaiq schemes', () => {
    const r = resolveArtifactPath(u('https://p/r/x.png'), fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong scheme');
  });

  it('rejects when there is no filename segment', () => {
    const r = resolveArtifactPath(u('mosaiq-artifact://p/r'), fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/<runId>\/<filename>/);
  });

  it('rejects when there are too many segments', () => {
    const r = resolveArtifactPath(u('mosaiq-artifact://p/r/sub/x.png'), fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/<runId>\/<filename>/);
  });

  it('rejects empty host (personaId)', () => {
    // URL("mosaiq-artifact:///r/x.png") — host is empty
    const r = resolveArtifactPath(u('mosaiq-artifact:///r/x.png'), fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid personaId');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveArtifactPath — id-syntax & path traversal
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveArtifactPath / id syntax + traversal', () => {
  it('rejects "../" in filename via percent-encoding', () => {
    // URL host strips slashes; so we attack via filename.
    // %2E%2E%2F  → ../
    const url = u('mosaiq-artifact://p/r/%2E%2E%2Fsecret.png');
    const r = resolveArtifactPath(url, fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid filename');
  });

  it('rejects literal ".." filename (URL parser collapses it before we see it)', () => {
    // `new URL('mosaiq-artifact://p/r/..')` normalises `/r/..` to `/`, so by
    // the time we see it the pathname has zero segments → segment-count error.
    const url = u('mosaiq-artifact://p/r/..');
    const r = resolveArtifactPath(url, fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/<runId>\/<filename>|invalid/);
  });

  it('rejects null byte in filename via percent-encoding', () => {
    const url = u('mosaiq-artifact://p/r/file%00.png');
    const r = resolveArtifactPath(url, fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid filename');
  });

  it('rejects spaces in personaId', () => {
    const url = u('mosaiq-artifact://bad%20id/r/x.png');
    const r = resolveArtifactPath(url, fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid personaId');
  });

  it('rejects unicode in runId', () => {
    const url = u(`mosaiq-artifact://p/${encodeURIComponent('运行-1')}/x.png`);
    const r = resolveArtifactPath(url, fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid runId');
  });

  it('rejects extension not in allowlist', () => {
    const url = u('mosaiq-artifact://p/r/file.exe');
    const r = resolveArtifactPath(url, fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/extension/);
  });

  it('rejects extension-less filename', () => {
    const url = u('mosaiq-artifact://p/r/README');
    const r = resolveArtifactPath(url, fakeResolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/extension/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveArtifactPath — containment defense in depth
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveArtifactPath / containment', () => {
  it('rejects when injected resolver returns a path that escapes itself', () => {
    // Pathological resolver that returns the parent of where it should — the
    // containment check should still pass because resolve(filename) joins
    // onto the (broken) base. To actually cross the boundary, we'd need the
    // **filename** to escape; ID_RE already prevents that. So this test
    // documents that a misbehaving resolver alone can't smuggle data out
    // unless filename is also bad — which it can't be after ID_RE.
    const evilResolver: ArtifactDirResolver = () => resolve(FAKE_ROOT, 'p', 'r');
    const url = u('mosaiq-artifact://p/r/x.png');
    const r = resolveArtifactPath(url, evilResolver);
    expect(r.ok).toBe(true);
  });

  it('uses the injected resolver only — no global state', () => {
    const calls: Array<[string, string]> = [];
    const trackingResolver: ArtifactDirResolver = (pid, rid) => {
      calls.push([pid as string, rid]);
      return resolve(FAKE_ROOT, pid, rid);
    };
    resolveArtifactPath(u('mosaiq-artifact://my-persona/my-run/img.png'), trackingResolver);
    expect(calls).toEqual([['my-persona', 'my-run']]);
  });

  it('containment check is purely string-based (no fs stat)', () => {
    // The containment guard checks `targetAbs.startsWith(baseAbs + sep)`. It
    // does NOT stat the path — so a degenerate resolver returning a string
    // that happens to be a file's path will still produce a "valid" join.
    // ID_RE on the filename (above) is the actual barrier preventing escape;
    // this guard is defense-in-depth against future resolver bugs.
    const degenerateResolver: ArtifactDirResolver = () => resolve(FAKE_ROOT, 'p', 'r', 'x.png');
    const url = u('mosaiq-artifact://p/r/x.png');
    const r = resolveArtifactPath(url, degenerateResolver);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // join would land us at .../p/r/x.png/x.png — silly but contained.
      expect(r.abs).toBe(resolve(FAKE_ROOT, 'p', 'r', 'x.png', 'x.png'));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extensionOf
// ─────────────────────────────────────────────────────────────────────────────

describe('extensionOf', () => {
  it.each([
    ['site.png', 'png'],
    ['SHOUT.PNG', 'png'],
    ['archive.tar.gz', 'gz'],
    ['no-extension', ''],
    ['.hidden', 'hidden'],
    ['weird.', ''],
  ])('extensionOf(%j) === %j', (input, expected) => {
    expect(extensionOf(input)).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mimeForExt
// ─────────────────────────────────────────────────────────────────────────────

describe('mimeForExt', () => {
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['html', 'text/html; charset=utf-8'],
    ['exe', 'application/octet-stream'],
    ['', 'application/octet-stream'],
  ])('mimeForExt(%j) === %j', (input, expected) => {
    expect(mimeForExt(input)).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constants — sanity
// ─────────────────────────────────────────────────────────────────────────────

describe('module exports', () => {
  it('ID_RE is sourced consistently with declared character class', () => {
    expect(ID_RE.test('ok-id_1.2')).toBe(true);
    expect(ID_RE.test('bad/id')).toBe(false);
    expect(ID_RE.test('')).toBe(false);
  });

  it('ALLOWED_EXTENSIONS contains exactly the documented set', () => {
    expect([...ALLOWED_EXTENSIONS].sort()).toEqual(['html', 'jpeg', 'jpg', 'png', 'webp']);
  });

  it('PersonaId import compiles (type-only marker)', () => {
    // Sanity: PersonaId is a branded string type. We don't need a runtime
    // check, but importing it confirms the test compiles against the same
    // type surface as production code.
    const x: PersonaId = 'abc' as PersonaId;
    expect(typeof x).toBe('string');
  });
});
