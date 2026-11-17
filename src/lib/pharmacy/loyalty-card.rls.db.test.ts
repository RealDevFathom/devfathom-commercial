/**
 * DEV-748 — physical loyalty cards against migrated PostgreSQL, under the restricted runtime role.
 *
 * The in-memory lifecycle suite re-implements the card rules, so it cannot show that the database
 * enforces them. This suite checks the real table:
 *
 *  - row-level security: a card of one organization is invisible to another, by id and by hash;
 *  - the partial unique index: two concurrent issues for one customer cannot both leave a working
 *    card behind;
 *  - the guard trigger: a revoked card cannot be changed again.
 *
 * Skipped (never silently passed) when no database URL is configured, like the other *.db.test.ts
 * suites.
 */
import { createHash, randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_dev748_rls_a_${suffix}`;
const ORG_B = `org_dev748_rls_b_${suffix}`;
const ACTOR = 'user_owner';

let withTenantDb: typeof import('@/lib/tenancy/scoped-db')['withTenantDb'];

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return withTenantDb(organizationId, work);
}

function codeHashFor(label: string): string {
  return createHash('sha256').update(`${label}-${randomBytes(8).toString('hex')}`).digest('hex');
}

/** One patient and one retail customer in the given tenant, created as that tenant. */
async function customerFixture(organizationId: string, label: string): Promise<string> {
  return inOrg(organizationId, async (db) => {
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: `Patient ${label}` },
    });
    const customer = await db.pharmacyCustomer.create({
      data: { organizationId, patientId: patient.id, displayName: `Customer ${label}` },
    });
    return customer.id;
  });
}

let customerA: string;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
  customerA = await customerFixture(ORG_A, `a-${suffix}`);
});

describeIfDatabase('DEV-748 loyalty cards — tenant isolation and rules in PostgreSQL', () => {
  it('hides a card from another organization, by id and by code hash', async () => {
    const hash = codeHashFor('isolation');
    const card = await inOrg(ORG_A, (db) =>
      db.pharmacyLoyaltyCard.create({
        data: {
          organizationId: ORG_A,
          customerId: customerA,
          codeHash: hash,
          issuedById: ACTOR,
        },
        select: { id: true },
      })
    );

    const seenByOther = await inOrg(ORG_B, (db) =>
      db.pharmacyLoyaltyCard.findFirst({ where: { id: card.id } })
    );
    expect(seenByOther).toBeNull();

    const byHashElsewhere = await inOrg(ORG_B, (db) =>
      db.pharmacyLoyaltyCard.findFirst({ where: { codeHash: hash } })
    );
    expect(byHashElsewhere).toBeNull();

    const seenByOwner = await inOrg(ORG_A, (db) =>
      db.pharmacyLoyaltyCard.findFirst({ where: { codeHash: hash, revokedAt: null } })
    );
    expect(seenByOwner?.id).toBe(card.id);
  });

  it('refuses a card for another tenant’s customer, even when written directly', async () => {
    await expect(
      inOrg(ORG_B, (db) =>
        db.pharmacyLoyaltyCard.create({
          data: {
            organizationId: ORG_B,
            customerId: customerA,
            codeHash: codeHashFor('cross-tenant'),
            issuedById: ACTOR,
          },
        })
      )
    ).rejects.toThrow();
  });

  it('lets only one of two concurrent issues leave a working card for a customer', async () => {
    const raceCustomer = await customerFixture(ORG_A, `race-${suffix}`);
    const results = await Promise.allSettled(
      [0, 1].map((i) =>
        inOrg(ORG_A, (db) =>
          db.pharmacyLoyaltyCard.create({
            data: {
              organizationId: ORG_A,
              customerId: raceCustomer,
              codeHash: codeHashFor(`race-${i}`),
              issuedById: ACTOR,
            },
          })
        )
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('never changes a revoked card again', async () => {
    const card = await inOrg(ORG_A, (db) =>
      db.pharmacyLoyaltyCard.create({
        data: {
          organizationId: ORG_A,
          customerId: await customerFixture(ORG_A, `revoke-${suffix}`),
          codeHash: codeHashFor('revoked'),
          issuedById: ACTOR,
        },
        select: { id: true },
      })
    );
    await inOrg(ORG_A, (db) =>
      db.pharmacyLoyaltyCard.update({
        where: { id: card.id },
        data: { revokedAt: new Date(), revokedById: ACTOR, revokedReason: 'Card lost' },
      })
    );
    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyLoyaltyCard.update({
          where: { id: card.id },
          data: { revokedReason: 'Changed later' },
        })
      )
    ).rejects.toThrow();
  });
});
ejects.toThrow();
  });
});
