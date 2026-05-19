/**
 * Unit tests for `buildArtifactUrl` — the renderer-side helper that constructs
 * `mosaiq-artifact://` URLs to feed into <img src="">.
 *
 * Key invariants:
 *   - scheme is always `mosaiq-artifact:`
 *   - personaId, runId, filename are each percent-encoded as a single segment
 *     (so reserved chars don't break URL parsing on the main process side)
 *   - Windows backslashes in `relativePath` are normalised to `/` BEFORE
 *     percent-encoding (so a slash in the relative path becomes %2F, which
 *     the protocol handler will reject — that's deliberate, the v0.9.3
 *     contract is one segment after runId).
 *   - The string round-trips through `new URL(...)` and emerges with the
 *     same personaId / runId / filename.
 */

import type { PersonaId } from '@mosaiq/persona-schema';
import { describe, expect, it } from 'vitest';

import { buildArtifactUrl } from './artifact-url.js';

// helper: parse the result and pull out the (decoded) host, runId, filename.
interface Decoded {
  scheme: string;
  personaId: string;
  segments: string[];
}
function decode(urlStr: string): Decoded {
  const u = new URL(urlStr);
  return {
    scheme: u.protocol.replace(/:$/, ''),
    personaId: decodeURIComponent(u.host),
    segments: u.pathname.split('/').filter(Boolean).map(decodeURIComponent),
  };
}

const PID = 'baseline-bench-mp6uss3k' as PersonaId;
const RID = '2026-05-18T13-44-26-599Z';

// ─────────────────────────────────────────────────────────────────────────────
// happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('buildArtifactUrl / happy path', () => {
  it('produces a mosaiq-artifact:// URL with the three segments', () => {
    const url = buildArtifactUrl(PID, RID, 'site-1.png');
    const d = decode(url);
    expect(d.scheme).toBe('mosaiq-artifact');
    expect(d.personaId).toBe(PID);
    expect(d.segments).toEqual([RID, 'site-1.png']);
  });

  it('starts with the literal scheme string', () => {
    const url = buildArtifactUrl(PID, RID, 'x.png');
    expect(url.startsWith('mosaiq-artifact://')).toBe(true);
  });

  it('returns identical output for identical inputs (deterministic)', () => {
    const a = buildArtifactUrl(PID, RID, 'x.png');
    const b = buildArtifactUrl(PID, RID, 'x.png');
    expect(a).toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// percent-encoding
// ─────────────────────────────────────────────────────────────────────────────

describe('buildArtifactUrl / encoding', () => {
  it('percent-encodes spaces in filename', () => {
    const url = buildArtifactUrl(PID, RID, 'has space.png');
    expect(url).toContain('has%20space.png');
    const d = decode(url);
    expect(d.segments[1]).toBe('has space.png');
  });

  it('percent-encodes "?" / "#" so query / fragment do not split the URL', () => {
    const url = buildArtifactUrl(PID, RID, 'a?b#c.png');
    // After encoding the "?" and "#" should be %3F and %23 respectively.
    expect(url).toContain('a%3Fb%23c.png');
    // And once parsed, the URL should have an empty search and hash:
    const u = new URL(url);
    expect(u.search).toBe('');
    expect(u.hash).toBe('');
  });

  it('percent-encodes "/" inside relativePath as %2F (defensive)', () => {
    // Even though the protocol handler rejects multi-segment filenames, the
    // builder must still produce a parseable URL — i.e. a slash in the
    // relativePath must NOT silently create a new path segment that bypasses
    // the runId check.
    const url = buildArtifactUrl(PID, RID, 'sub/x.png');
    expect(url).toContain('sub%2Fx.png');
    const d = decode(url);
    // Still exactly two segments — runId, filename.
    expect(d.segments).toHaveLength(2);
    expect(d.segments[1]).toBe('sub/x.png');
  });

  it('handles unicode in personaId via percent-encoding', () => {
    // ASCII-only is the contract, but the builder must not crash on unicode.
    // (The main-process resolver will reject this, which is correct.)
    const u = buildArtifactUrl('bench-中文' as PersonaId, RID, 'x.png');
    expect(u).toContain('bench-%E4%B8%AD%E6%96%87');
  });

  it('percent-encodes a personaId containing a colon', () => {
    const u = buildArtifactUrl('weird:id' as PersonaId, RID, 'x.png');
    // Colon is special in URLs; encodeURIComponent yields %3A
    expect(u).toContain('weird%3Aid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Windows backslash normalisation
// ─────────────────────────────────────────────────────────────────────────────

describe('buildArtifactUrl / Windows paths', () => {
  it('normalises backslashes to forward slashes before encoding', () => {
    // On Windows, SiteResult.screenshot could conceivably arrive as
    // "sub\\file.png" if the SDK ever stored nested artifacts. The builder
    // collapses to forward slashes first, then percent-encodes the slash so
    // the URL still parses with exactly two path segments.
    const url = buildArtifactUrl(PID, RID, 'sub\\file.png');
    const d = decode(url);
    expect(d.segments).toEqual([RID, 'sub/file.png']);
  });

  it('normalises a chain of backslashes', () => {
    const url = buildArtifactUrl(PID, RID, 'a\\b\\c.png');
    const d = decode(url);
    expect(d.segments[1]).toBe('a/b/c.png');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// timestamp-shaped runIds
// ─────────────────────────────────────────────────────────────────────────────

describe('buildArtifactUrl / runId shapes', () => {
  it('preserves typical iso-ish runId timestamps verbatim', () => {
    const url = buildArtifactUrl(PID, '2026-05-18T13-44-26-599Z', 'x.png');
    const d = decode(url);
    expect(d.segments[0]).toBe('2026-05-18T13-44-26-599Z');
  });

  it('round-trips runIds containing dots', () => {
    const url = buildArtifactUrl(PID, 'run.with.dots', 'x.png');
    const d = decode(url);
    expect(d.segments[0]).toBe('run.with.dots');
  });
});
