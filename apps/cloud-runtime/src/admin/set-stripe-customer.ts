/**
 * Phase 11.7b: map a project to its Stripe customer id.
 *
 * The StripeMeterReporter attributes a project's billable browser-minutes to
 * `projects.stripe_customer_id`. A project without a mapping has its usage
 * pushes refused (rows stay unreported, `usage_events_unreported` gauge climbs)
 * so billable minutes are never silently dropped. This admin utility wires the
 * mapping directly into the prod sqlite.
 *
 * On Fly:
 *   flyctl ssh console -a mosaiq-cloud-runtime -C \
 *     'node dist/admin/set-stripe-customer.js proj_launchai cus_ABC123'
 *
 * Idempotent: re-running with the same customer id is a no-op (status='unchanged').
 * Passing an empty customer id ('' / '-') clears the mapping (status='cleared').
 */

import { eq } from 'drizzle-orm';

import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { projects } from '../db/schema.js';

export interface SetStripeCustomerInput {
  projectId: string;
  /** `cus_...`; empty string clears the mapping. */
  stripeCustomerId: string;
}

export interface SetStripeCustomerResult {
  projectId: string;
  stripeCustomerId: string | null;
  status: 'set' | 'cleared' | 'unchanged';
}

/**
 * Library form: callable from tests / a future admin HTTP endpoint without
 * shelling out. The CLI entry below wraps this.
 */
export async function setProjectStripeCustomer(
  input: SetStripeCustomerInput,
): Promise<SetStripeCustomerResult> {
  await ensureSchema();
  const handle = await getDb();
  const db = handle.drizzle;

  const next = input.stripeCustomerId.trim();
  const normalized = next === '' || next === '-' ? null : next;

  const rows = await db
    .select({ id: projects.id, stripeCustomerId: projects.stripeCustomerId })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    throw new Error(`project ${input.projectId} not found`);
  }

  const current = existing.stripeCustomerId ?? null;
  if (current === normalized) {
    return { projectId: input.projectId, stripeCustomerId: normalized, status: 'unchanged' };
  }

  await db
    .update(projects)
    .set({ stripeCustomerId: normalized })
    .where(eq(projects.id, input.projectId));

  return {
    projectId: input.projectId,
    stripeCustomerId: normalized,
    status: normalized === null ? 'cleared' : 'set',
  };
}

// CLI 入口 — `node dist/admin/set-stripe-customer.js <projectId> <cus_...|->`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const projectId = positional[0] ?? process.env.MOSAIQ_PROJECT_ID;
  const stripeCustomerId = positional[1] ?? process.env.MOSAIQ_STRIPE_CUSTOMER_ID;

  if (!projectId || stripeCustomerId === undefined) {
    console.error('usage: node admin/set-stripe-customer.js <projectId> <cus_...|-to-clear>');
    console.error('   or: MOSAIQ_PROJECT_ID=... MOSAIQ_STRIPE_CUSTOMER_ID=... node ...');
    process.exit(2);
  }

  try {
    const result = await setProjectStripeCustomer({ projectId, stripeCustomerId });
    console.log(JSON.stringify(result, null, 2));
    await disposeDb();
    process.exit(0);
  } catch (err) {
    console.error(
      '[admin/set-stripe-customer] failed:',
      err instanceof Error ? err.message : String(err),
    );
    await disposeDb();
    process.exit(1);
  }
}
