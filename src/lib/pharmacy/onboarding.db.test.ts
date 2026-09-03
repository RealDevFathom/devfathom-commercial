/**
 * PLAT-03 / PLAT-04 — the database half of the onboarding contract, against
 * migrated PostgreSQL with FORCED row-level security.
 *
 * The evaluation rules themselves are covered without a database in
 * `onboarding.test.ts`. What only a real database can prove is here:
 *
 *  - a gate row claiming PASSED with real backing data absent is downgraded by
 *    `evaluatePharmacyReadiness` running its real queries, not by a stub;
 *  - the same gate flips to PASSED the moment the backing row actually exists,
 *    so the downgrade is a genuine evidence check and not a blanket refusal;
 *  - the table itself refuses a status moved without an actor and a time;
 *  - the transition log cannot be rewritten or deleted; and
 *  - all four new tables are tenant-isolated under FORCE RLS.
 *
 * Every statement runs as the NOSUPERUSER/NOBYPASSRLS runtime role, so FORCE
 * RLS applies to this suite too. Skipped (never silently passed) when the
 * database URLs are absent.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const RUNTIME_DATABASE_URL =
  process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
if (RUNTIME_DATABASE_URL) process.env.DATABASE_URL = RUNTIME_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = RUNTIME_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1174_a_${suffix}`;
const ORG_B = `org_wha1174_b_${suffix}`;
const BRANCH_A = `branch_wha1174_a_${suffix}`;

const NEW_TABLES = [
  'pharmacy_branches',
  'pharmacy_onboarding_states',
  'pharmacy_onboarding_gate_states',
  'pharmacy_onboarding_events',
] as const;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  onboarding: typeof import('./onboarding');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

/** A tenant-scoped raw client with the organization GUC set, as the app runs. */
async function tenantClient(organizationId: string) {
  const client = new Client({ connectionString: RUNTIME_DATABASE_URL });
  await client.connect();
  await client.query(`SELECT set_config('app.current_organization_id', $1, false)`, [
    organizationId,
  ]);
  return client;
}

beforeAll(async () => {
  if (!RUNTIME_DATABASE_URL || !OWNER_DATABASE_URL) return;
  expect(RUNTIME_DATABASE_URL).not.toBe(OWNER_DATABASE_URL);

  deps = {
    withTenantDb: (await import('@/lib/tenancy/scoped-db')).withTenantDb,
    onboarding: await import('./onboarding'),
  };

  const runtime = new Client({ connectionString: RUNTIME_DATABASE_URL });
  await runtime.connect();
  try {
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    // Connected as either, every isolation case below would pass for the wrong
    // reason: the policies would simply not apply.
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  } finally {
    await runtime.end();
  }

  // Organizations are a platform table, so the owner seeds them.
  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query(
      `INSERT INTO organizations
        (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'WHA-1174 A', 'WHA-1174 A', 'PHARMACY', 'ONBOARDING', 'SHARED', now(), now()),
              ($3, $4, 'WHA-1174 B', 'WHA-1174 B', 'PHARMACY', 'ONBOARDING', 'SHARED', now(), now())`,
      [ORG_A, `wha1174-a-${suffix}`, ORG_B, `wha1174-b-${suffix}`]
    );
  } finally {
    await owner.end();
  }

  // Everything else is created as the tenant would create it, so RLS and every
  // CHECK apply to the fixture as well.
  await inOrg(ORG_A, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: BRANCH_A,
        organizationId: ORG_A,
        code: 'MAIN',
        name: 'Main branch',
        addressLine: '1 Mall Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    await db.pharmacyOnboardingState.create({ data: { organizationId: ORG_A } });
  });
  await inOrg(ORG_B, (db) =>
    db.pharmacyOnboardingState.create({ data: { organizationId: ORG_B } })
  );
});

afterAll(async () => {
  if (!OWNER_DATABASE_URL) return;
  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('DELETE FROM organizations WHERE id = ANY($1)', [[ORG_A, ORG_B]]);
    await owner.query('DELETE FROM pharmacy_branches WHERE "organizationId" = ANY($1)', [
      [ORG_A, ORG_B],
    ]);
  } finally {
    await owner.end();
  }
});

describeIfDatabase('PLAT-03 readiness — seed data cannot fake readiness', () => {
  it('downgrades a PASSED gate row that no backing data supports', async () => {
    // Exactly the shape a seed would write: a fully formed, fully attested row
    // asserting that suppliers are ready. No supplier exists.
    await inOrg(ORG_A, (db) =>
      db.pharmacyOnboardingGateState.create({
        data: {
          organizationId: ORG_A,
          gate: 'PARTIES_AND_BALANCES',
          status: 'PASSED',
          evidenceRef: 'file://supplier-agreements.pdf',
          actorId: 'seed',
          recordedAt: new Date(),
        },
      })
    );

    const before = await inOrg(ORG_A, (db) => deps.onboarding.evaluatePharmacyReadiness(db, ORG_A));
    const gateBefore = before.gates.find((gate) => gate.gate === 'PARTIES_AND_BALANCES')!;
    expect(gateBefore.claimedStatus).toBe('PASSED');
    expect(gateBefore.status).toBe('FAILED');
    expect(gateBefore.downgradeReason).toBe('EVIDENCE_ABSENT');
    expect(before.ready).toBe(false);
    expect(before.blocking).toContain('PARTIES_AND_BALANCES');
  });

  it('passes the same gate once the backing row genuinely exists', async () => {
    // The stored claim has not changed at all; only the data has. This is what
    // makes the case above an evidence check and not a blanket refusal.
    await inOrg(ORG_A, (db) =>
      db.pharmacySupplier.create({
        data: {
          organizationId: ORG_A,
          name: `Distributor ${suffix}`,
          authorized: true,
          active: true,
        },
      })
    );

    const after = await inOrg(ORG_A, (db) => deps.onboarding.evaluatePharmacyReadiness(db, ORG_A));
    const gateAfter = after.gates.find((gate) => gate.gate === 'PARTIES_AND_BALANCES')!;
    expect(gateAfter.status).toBe('PASSED');
    expect(gateAfter.downgradeReason).toBeNull();
    // Still not ready: the other eleven P0 gates have not been satisfied.
    expect(after.ready).toBe(false);
    expect(after.blocking).not.toContain('PARTIES_AND_BALANCES');
  });

  it('derives an evidence-backed gate with no gate row recorded at all', async () => {
    // The roles gate is satisfied by seeding the vertical's role templates. No
    // `pharmacy_onboarding_gate_states` row is written for it here.
    const { roleTemplatesForVertical } = await import('@/lib/vertical-catalog');
    const templates = roleTemplatesForVertical('PHARMACY');
    await inOrg(ORG_A, (db) =>
      db.organizationRole.createMany({
        data: templates.map((template) => ({
          organizationId: ORG_A,
          key: template.key,
          name: template.name,
          isSystem: template.isSystem,
        })),
        skipDuplicates: true,
      })
    );

    const readiness = await inOrg(ORG_A, (db) =>
      deps.onboarding.evaluatePharmacyReadiness(db, ORG_A)
    );
    const gate = readiness.gates.find((one) => one.gate === 'OWNER_AND_ROLE_TEMPLATES')!;
    expect(gate.claimedStatus).toBe('NOT_STARTED');
    expect(gate.status).toBe('PASSED');
  });

  it('leaves the six console gates explicitly NOT_STARTED', async () => {
    const readiness = await inOrg(ORG_A, (db) =>
      deps.onboarding.evaluatePharmacyReadiness(db, ORG_A)
    );
    expect(
      readiness.gates.filter((gate) => !gate.evidenceBacked).map((gate) => gate.status)
    ).toEqual(Array(6).fill('NOT_STARTED'));
  });

  it("reads only its own tenant: org B sees none of org A's gate rows", async () => {
    const readiness = await inOrg(ORG_B, (db) =>
      deps.onboarding.evaluatePharmacyReadiness(db, ORG_B)
    );
    expect(readiness.gates.every((gate) => gate.claimedStatus === 'NOT_STARTED')).toBe(true);
    expect(readiness.ready).toBe(false);
  });
});

describeIfDatabase('PLAT-03 persistence — the table enforces its own rules', () => {
  it('refuses a status moved off NOT_STARTED without an actor and a time', async () => {
    const client = await tenantClient(ORG_A);
    try {
      await expect(
        client.query(
          `INSERT INTO pharmacy_onboarding_gate_states
             (id, "organizationId", gate, status, "updatedAt")
           VALUES ($1, $2, 'DEVICES_AND_DOCUMENTS', 'PASSED', now())`,
          [`gate_bare_${suffix}`, ORG_A]
        )
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.end();
    }
  });

  it('refuses to update or delete a recorded transition (append-only)', async () => {
    const client = await tenantClient(ORG_A);
    try {
      await client.query(
        `INSERT INTO pharmacy_onboarding_events
           (id, "organizationId", gate, "fromStatus", "toStatus", "actorId")
         VALUES ($1, $2, 'ORG_TYPE', 'NOT_STARTED', 'IN_PROGRESS', 'user_owner')`,
        [`event_${suffix}`, ORG_A]
      );
      await expect(
        client.query(`UPDATE pharmacy_onboarding_events SET "toStatus" = 'PASSED' WHERE id = $1`, [
          `event_${suffix}`,
        ])
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        client.query(`DELETE FROM pharmacy_onboarding_events WHERE id = $1`, [`event_${suffix}`])
      ).rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await client.end();
    }
  });

  it('allows only one onboarding record per organization', async () => {
    await expect(
      inOrg(ORG_A, (db) => db.pharmacyOnboardingState.create({ data: { organizationId: ORG_A } }))
    ).rejects.toThrow();
  });

  it('forces tenant RLS on every table this migration created', async () => {
    const client = await tenantClient(ORG_A);
    try {
      const forced = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname = ANY($1::text[]) ORDER BY relname`,
        [[...NEW_TABLES]]
      );
      expect(forced.rows).toHaveLength(NEW_TABLES.length);
      for (const row of forced.rows) {
        expect({ [row.relname]: [row.relrowsecurity, row.relforcerowsecurity] }).toEqual({
          [row.relname]: [true, true],
        });
      }
    } finally {
      await client.end();
    }
  });

  it("hides another tenant's branch and refuses to write into it", async () => {
    const client = await tenantClient(ORG_B);
    try {
      const visible = await client.query(`SELECT id FROM pharmacy_branches WHERE id = $1`, [
        BRANCH_A,
      ]);
      expect(visible.rowCount).toBe(0);
      // The WITH CHECK half: org B cannot create a row claiming org A either.
      await expect(
        client.query(
          `INSERT INTO pharmacy_branches
             (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
           VALUES ($1, $2, 'X', 'X', 'x', 'x', 'PB', now())`,
          [`branch_steal_${suffix}`, ORG_A]
        )
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });
});
