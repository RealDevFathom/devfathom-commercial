/**
 * Seat limit under real concurrency (follow-up to #164 / #199).
 *
 * Every path that creates or reactivates a user funnels through
 * `lockOrganizationSeat`, which takes a `FOR UPDATE` lock on the organization
 * row before counting occupied seats. This test proves that lock actually
 * serializes competing transactions against a real PostgreSQL: a burst of
 * parallel "invites" racing for the last free seats can never push the occupied
 * count past the limit. Without the row lock, each transaction would read the
 * same pre-insert count and all of them would be admitted.
 *
 * Requires a disposable database. `TEST_DATABASE_URL` is the restricted runtime
 * role (NOSUPERUSER NOBYPASSRLS); the owner URL seeds fixtures. Skipped — never
 * silently passed — when either is absent. Run with `TZ=UTC`.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runtimeUrl = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
const ownerUrl =
  process.env.M8_TEST_OWNER_DATABASE_URL ?? process.env.WHA566_OWNER_DATABASE_URL ?? '';
const describeIfDatabase = runtimeUrl && ownerUrl ? describe : describe.skip;
if (runtimeUrl && runtimeUrl === ownerUrl)
  throw new Error('Runtime and owner database URLs must differ');
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let lockOrganizationSeat: typeof import('@/lib/organization-seat').lockOrganizationSeat;

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const organizationId = `seat_org_${suffix}`;
const DEPARTMENT = 'LEADERSHIP';
const SEAT_LIMIT = 5;
const PRESEEDED_ACTIVE = 3; // 2 free seats remain
const PARALLEL_INVITES = 8;

const owner = new pg.Client({ connectionString: ownerUrl });

describeIfDatabase('organization seat limit under concurrency', () => {
  beforeAll(async () => {
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    ({ lockOrganizationSeat } = await import('@/lib/organization-seat'));
    await owner.connect();
    await owner.query(`SET app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
      [organizationId]
    );
    await owner.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
       VALUES ($1,$2,$3,$3,now())`,
      [`dept_${suffix}`, organizationId, DEPARTMENT]
    );
    for (let i = 0; i < PRESEEDED_ACTIVE; i += 1) {
      await owner.query(
        `INSERT INTO users (id, "organizationId", name, email, department, title, status, "updatedAt")
         VALUES ($1,$2,$3,$4,$5,'Member','ACTIVE',now())`,
        [`seat_seed_${suffix}_${i}`, organizationId, `Seed ${i}`, `seed_${i}_${suffix}@acme.test`, DEPARTMENT]
      );
    }
  });

  afterAll(async () => {
    await owner.query(`SET app.is_platform_admin = 'true'`);
    await owner.query(`DELETE FROM users WHERE "organizationId" = $1`, [organizationId]);
    await owner.query(`DELETE FROM organization_departments WHERE "organizationId" = $1`, [
      organizationId,
    ]);
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [organizationId]);
    await owner.end();
  });

  it('never admits more invites than the free seats, however many race', async () => {
    const invite = (index: number) =>
      withTenantDb(organizationId, async (tx: ScopedDb) => {
        await lockOrganizationSeat(tx, organizationId, SEAT_LIMIT);
        return tx.user.create({
          data: {
            organizationId,
            name: `Invitee ${index}`,
            email: `invitee_${index}_${suffix}@acme.test`,
            department: DEPARTMENT,
            title: 'Invitee',
            status: 'INVITED',
          },
          select: { id: true },
        });
      });

    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL_INVITES }, (_, index) => invite(index))
    );

    const admitted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );

    // Exactly the free seats were filled, not one more.
    expect(admitted).toHaveLength(SEAT_LIMIT - PRESEEDED_ACTIVE);
    expect(rejected).toHaveLength(PARALLEL_INVITES - (SEAT_LIMIT - PRESEEDED_ACTIVE));
    // Every loser failed for the seat-limit reason, not a deadlock or FK error.
    for (const failure of rejected) {
      expect(String(failure.reason?.message ?? failure.reason)).toContain('Seat limit reached');
    }

    // The durable truth: occupied seats land exactly on the limit.
    const occupied = await withTenantDb(organizationId, (tx: ScopedDb) =>
      tx.user.count({
        where: { organizationId, status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] } },
      })
    );
    expect(occupied).toBe(SEAT_LIMIT);
  });
});
