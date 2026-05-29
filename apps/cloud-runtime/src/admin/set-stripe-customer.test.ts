/**
 * Phase 11.7b: setProjectStripeCustomer admin utility + resolveStripeCustomerIdFromDb.
 *
 * In-memory sqlite + resetEnvCache to isolate state between cases.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema } from '../db/bootstrap.js';
import { disposeDb, getDb } from '../db/client.js';
import { projects } from '../db/schema.js';
import { resetEnvCache } from '../env.js';
import { resolveStripeCustomerIdFromDb } from '../usage/reporter.js';
import { setProjectStripeCustomer } from './set-stripe-customer.js';

describe('setProjectStripeCustomer', () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = 'sqlite::memory:';
    process.env.SEED_API_KEY = '';
    resetEnvCache();
    await ensureSchema();
    const handle = await getDb();
    await handle.drizzle.insert(projects).values({ id: 'proj_a', name: 'a' });
  });

  afterEach(async () => {
    await disposeDb();
  });

  it('sets the mapping on a project with none', async () => {
    const result = await setProjectStripeCustomer({
      projectId: 'proj_a',
      stripeCustomerId: 'cus_ABC123',
    });
    expect(result.status).toBe('set');
    expect(result.stripeCustomerId).toBe('cus_ABC123');

    const handle = await getDb();
    const rows = await handle.drizzle
      .select({ c: projects.stripeCustomerId })
      .from(projects)
      .where(eq(projects.id, 'proj_a'));
    expect(rows[0]?.c).toBe('cus_ABC123');
  });

  it('idempotent: setting the same value returns unchanged', async () => {
    await setProjectStripeCustomer({ projectId: 'proj_a', stripeCustomerId: 'cus_X' });
    const again = await setProjectStripeCustomer({
      projectId: 'proj_a',
      stripeCustomerId: 'cus_X',
    });
    expect(again.status).toBe('unchanged');
  });

  it('clears the mapping with empty / dash', async () => {
    await setProjectStripeCustomer({ projectId: 'proj_a', stripeCustomerId: 'cus_X' });
    const cleared = await setProjectStripeCustomer({ projectId: 'proj_a', stripeCustomerId: '-' });
    expect(cleared.status).toBe('cleared');
    expect(cleared.stripeCustomerId).toBeNull();
  });

  it('unknown project → throws', async () => {
    await expect(
      setProjectStripeCustomer({ projectId: 'proj_missing', stripeCustomerId: 'cus_X' }),
    ).rejects.toThrow(/not found/);
  });

  it('resolveStripeCustomerIdFromDb reflects set/clear', async () => {
    expect(await resolveStripeCustomerIdFromDb('proj_a')).toBeNull();
    await setProjectStripeCustomer({ projectId: 'proj_a', stripeCustomerId: 'cus_Y' });
    expect(await resolveStripeCustomerIdFromDb('proj_a')).toBe('cus_Y');
    await setProjectStripeCustomer({ projectId: 'proj_a', stripeCustomerId: '' });
    expect(await resolveStripeCustomerIdFromDb('proj_a')).toBeNull();
  });

  it('resolveStripeCustomerIdFromDb returns null for unknown project', async () => {
    expect(await resolveStripeCustomerIdFromDb('proj_nope')).toBeNull();
  });
});
