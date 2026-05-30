/**
 * Default persona seeds for Browserbase-compat empty-body sessions.
 *
 * Stored in the `personas` table with `source='seed'` and `project_id=NULL`
 * (globally visible to every project). `ensureDefaultPersonas()` inserts them
 * exactly once at startup if no seed-source rows exist (idempotent).
 *
 * Picked at random by POST /v1/sessions when the caller omits `persona`
 * entirely (typical `bb.sessions.create({})` from the Stagehand SDK).
 *
 * ## Determinism
 *
 * Each entry pins a hardcoded `masterSeed` (8-char hex) so the serialized
 * persona JSON is byte-stable across deploys. New entries should pick a
 * fresh value once via `crypto.randomBytes(4).toString('hex')` and paste it
 * as a constant — **never regenerate**, since changing the seed silently
 * rotates the canvas/webgl fingerprint of every prod caller that relies on
 * the default pool, breaking site reputation.
 */

import type { Persona } from '@runova/persona-schema';
import {
  createMacosSonomaChromeUsPersona,
  createUbuntu2204ChromeUsPersona,
  createWin10ChromeUsPersona,
  createWin11ChromeUsPersona,
} from '@runova/persona-schema/templates';

export interface DefaultPersonaSeed {
  /**
   * DB primary key for `personas.id`. Stable, prefixed with `pers_default_`
   * so it's distinguishable from user-created personas (whose ids come from
   * `newId('pers')` and look like `pers_<base32>`).
   */
  readonly dbId: string;
  /** Validated Persona JSON; `metadata.id` is PersonaIdSchema-valid kebab-case. */
  readonly persona: Persona;
}

// All defaults pin to US East timezone. Operator can add more regions later
// via admin CLI; the random picker will spread load across whatever exists.
const TIMEZONE = 'America/New_York';
const SEED_NOTE =
  'Seeded by cloud-runtime for Browserbase-compat empty-body requests. Do not delete.';

export const DEFAULT_PERSONAS: ReadonlyArray<DefaultPersonaSeed> = [
  {
    dbId: 'pers_default_win11_chrome_us',
    persona: createWin11ChromeUsPersona({
      id: 'win11-chrome-us-default',
      displayName: 'Default · Win11 + Chrome (US East)',
      tags: ['default', 'seed', 'win11', 'us'],
      notes: SEED_NOTE,
      timezone: TIMEZONE,
      masterSeed: 'a1b2c3d4',
    }),
  },
  {
    dbId: 'pers_default_win10_chrome_us',
    persona: createWin10ChromeUsPersona({
      id: 'win10-chrome-us-default',
      displayName: 'Default · Win10 + Chrome (US East)',
      tags: ['default', 'seed', 'win10', 'us'],
      notes: SEED_NOTE,
      timezone: TIMEZONE,
      masterSeed: 'e5f6a7b8',
    }),
  },
  {
    dbId: 'pers_default_macos_sonoma_chrome_us',
    persona: createMacosSonomaChromeUsPersona({
      id: 'macos-sonoma-chrome-us-default',
      displayName: 'Default · macOS Sonoma + Chrome (US East)',
      tags: ['default', 'seed', 'macos', 'us'],
      notes: SEED_NOTE,
      timezone: TIMEZONE,
      masterSeed: 'c9d0e1f2',
    }),
  },
  {
    dbId: 'pers_default_ubuntu_2204_chrome_us',
    persona: createUbuntu2204ChromeUsPersona({
      id: 'ubuntu-2204-chrome-us-default',
      displayName: 'Default · Ubuntu 22.04 + Chrome (US East)',
      tags: ['default', 'seed', 'ubuntu', 'us'],
      notes: SEED_NOTE,
      timezone: TIMEZONE,
      masterSeed: '03142536',
    }),
  },
];

/**
 * Pick one of the default persona DB ids at random. The session handler then
 * looks up the row via the same code path as `persona: { id: '...' }` from a
 * regular request — if for some reason the seed was operator-deleted, that
 * lookup will throw 404 `persona.not_found` with a clear id, signalling that
 * the operator needs to re-seed (e.g. drop the row and bounce the server).
 *
 * Random rather than round-robin: gives a tiny bit of fingerprint diversity
 * across consecutive empty-body sessions without needing a hot counter, and
 * keeps the function pure / no module-level state.
 */
export function pickDefaultPersonaDbId(): string {
  const i = Math.floor(Math.random() * DEFAULT_PERSONAS.length);
  // Non-null assertion is safe: DEFAULT_PERSONAS is non-empty at compile time.
  return DEFAULT_PERSONAS[i]!.dbId;
}
