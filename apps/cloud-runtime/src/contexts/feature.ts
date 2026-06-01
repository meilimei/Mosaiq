/**
 * Phase 11.6 — contexts feature gate + signed internal-URL helpers.
 *
 * Shared single-source between routes/contexts.ts (CRUD) and routes/sessions.ts
 * (browserSettings.context integration). Keeping the gate + URL signing here
 * avoids drift between the two call sites and keeps the env-coupling in one spot.
 */

import { loadEnv } from '../env.js';
import { signInternalToken } from '../utils/crypto.js';
import { ApiError } from '../utils/errors.js';

/**
 * Feature is enabled iff BOTH secrets are configured. env.ts superRefine already
 * enforces the "both or neither" invariant, so checking one would suffice — but
 * we check both for defensive clarity.
 */
export function contextsEnabled(): boolean {
  const env = loadEnv();
  return Boolean(env.MOSAIQ_CONTEXT_MASTER_KEY && env.MOSAIQ_INTERNAL_HMAC_SECRET);
}

/**
 * Throws `context.disabled` (503) when the feature is off. Unlike phase 11.5
 * keepAlive (which uses quota=0 as a kill switch), contexts MUST be explicitly
 * enabled with secrets — without a master key we cannot encrypt blobs at rest
 * nor sign internal tokens, and serving plaintext would be a security regression.
 */
export function ensureContextsEnabled(): void {
  if (!contextsEnabled()) {
    throw new ApiError(
      'context.disabled',
      'Contexts API is not enabled on this deployment. Set MOSAIQ_CONTEXT_MASTER_KEY and MOSAIQ_INTERNAL_HMAC_SECRET fly secrets to enable.',
    );
  }
}

/**
 * Base URL pods use to reach cloud-runtime's internal endpoints. Per design
 * §5.3/§5.5 we reuse PUBLIC_BASE_URL (the HMAC token is the actual auth, so the
 * endpoint can even be public). In Fly prod this resolves through the public LB;
 * a future knob could point it at the 6PN private address. Trailing slash trimmed
 * so the join below never doubles `//`.
 */
function internalBaseUrl(): string {
  return loadEnv().PUBLIC_BASE_URL.replace(/\/+$/, '');
}

/**
 * Signed URL the pod GETs to download a context's encrypted blob at session boot.
 * Token binds (ctxId, 'download', expiresAt) with a 5-min TTL.
 */
export function signContextDownloadUrl(ctxId: string): string {
  const env = loadEnv();
  const token = signInternalToken(env.MOSAIQ_INTERNAL_HMAC_SECRET, ctxId, 'download');
  return `${internalBaseUrl()}/v1/_internal/contexts/${ctxId}/download?token=${token}`;
}

/**
 * Signed URL the pod PUTs to upload a fresh snapshot during graceful close.
 * Token binds (ctxId, 'snapshot', expiresAt) with a 5-min TTL.
 */
export function signContextSnapshotUrl(ctxId: string): string {
  const env = loadEnv();
  const token = signInternalToken(env.MOSAIQ_INTERNAL_HMAC_SECRET, ctxId, 'snapshot');
  return `${internalBaseUrl()}/v1/_internal/contexts/${ctxId}/snapshot?token=${token}`;
}
