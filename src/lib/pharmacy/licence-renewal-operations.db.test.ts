// @vitest-environment node
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { renderRenewalDigest } from './licence-renewal';

vi.mock('server-only', () => ({}));

const runtimeUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.M8_TEST_OWNER_DATABASE_URL;
if (runtimeUrl) process.env.DATABASE_URL = runtimeUrl;
const describeDb = runtimeUrl && ownerUrl ? describe : describe.skip;

const suffix = randomBytes(5).toString('hex');
const orgA = `org_ren720_a_${suffix}`;
const orgB = `org_ren720_b_${suffix}`;
const branchA = `branch_ren720_a_${suffix}`;
const branchB = `branch_ren720_b_${suffix}`;
const supplierA = `supplier_ren720_a_${suffix}`;
const DAY_MS = 86_400_000;
const NOW = new Date();
// Columns are `timestamp(3)` holding UTC wall time, as Prisma writes them: send
// ISO strings, whose zone suffix Postgres ignores for a zoneless timestamp.
const iso = (date: Date) => date.toISOString();
const inDays = (days: number) => iso(new Date(NOW.getTime() + days * DAY_MS));

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  operations: typeof import('./licence-renewal-operations');
};
let deps: Deps;

const PROFILE_INSERT = `INSERT INTO pharmacy_branch_regulatory_profiles
  (id, "organizationId", "branchId", version, "effectiveFrom", "effectiveTo", "provinceCode",
   "jurisdictionRuleSetId", premises, "licenceCategory", "licenceNumber",
   "licenceValidFrom", "licenceValidTo", "licenceEvidenceFileRef", "permittedSchedules",
   "qualifiedPersonRegistration", "qualifiedPersonValidFrom", "qualifiedPersonValidTo",
   "qualifiedPersonCoverageRosterRef", "fiscalStatus", "retentionPolicy")
  VALUES ($1, $2, $3, $4, $5, $6, 'PK-PB', 'pk_pb_provisional_v1', '{}',
   'PHARMACY', $7, $5, $8, 'file', ARRAY[]::text[],
   'QP-1', $5, $9, 'roster', 'UNCONFIRMED', '{}')`;

async function asOwner<T>(work: (client: pg.Client) => Promise<T>) {
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(`SET app.is_platform_admin = 'true'`);
    return await work(owner);
  } finally {
    await owner.end();
  }
}

const read = (organizationId: string, branchIds: string[], at = NOW) =>
  deps.withTenantDb(organizationId, (db: ScopedDb) =>
    deps.operations.readLicenceRenewalReminders(db, { organizationId, branchIds, at })
  );

beforeAll(async () => {
  if (!runtimeUrl || !ownerUrl) return;
  const [scoped, operations, guard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./licence-renewal-operations'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scoped.withTenantDb, operations };
  await guard.assertRlsEnforcingRole(scoped.withPlatformDb);
  await asOwner(async (owner) => {
    await owner.query(
      `INSERT INTO organizations
         (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'REN-720 A', 'REN-720 A', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
              ($3, $4, 'REN-720 B', 'REN-720 B', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      [orgA, `ren720-a-${suffix}`, orgB, `ren720-b-${suffix}`]
    );
    await owner.query(
      `INSERT INTO pharmacy_branches
         (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
       VALUES ($1, $2, $1, 'Main', '1 Test Road', 'Lahore', 'PB', now()),
              ($3, $4, $3, 'Other', '2 Test Road', 'Lahore', 'PB', now())`,
      [branchA, orgA, branchB, orgB]
    );
    // Seeded: org A's branch licence expires in 30 days; its qualified person is current.
    await owner.query(PROFILE_INSERT, [
      `profile_ren720_a1_${suffix}`,
      orgA,
      branchA,
      1,
      inDays(-700),
      null,
      'DSL-OLD',
      inDays(30),
      inDays(400),
    ]);
    // Org B's licence is also due; it must never surface in org A.
    await owner.query(PROFILE_INSERT, [
      `profile_ren720_b1_${suffix}`,
      orgB,
      branchB,
      1,
      inDays(-700),
      null,
      'DSL-B',
      inDays(20),
      inDays(400),
    ]);
    await owner.query(
      `INSERT INTO pharmacy_suppliers (id, "organizationId", name, authorized, "updatedAt")
       VALUES ($1, $2, $1, true, now())`,
      [supplierA, orgA]
    );
    await owner.query(
      `INSERT INTO pharmacy_supplier_licences
         (id, "organizationId", "supplierId", "licenceType", "licenceNumber",
          "issuingAuthority", "issuedAt", "expiresAt", "verifiedAt")
       VALUES ($1, $2, $3, 'WHOLESALE', 'WS-1', 'Test authority', now(), $4, now())`,
      [`licence_ren720_a1_${suffix}`, orgA, supplierA, inDays(7)]
    );
  });
}, 120_000);

afterAll(async () => {
  // Regulated profile rows are append-only; fixture rows stay in the throwaway database.
});

describeDb('#720 licence renewal reminders (forced RLS)', () => {
  it.each([
    {
      name: 'a successor after expiry',
      start: 30,
      end: 30,
      licenceFrom: 30,
      qpFrom: 30,
      due: ['BRANCH_LICENCE', 'QUALIFIED_PERSON_REGISTRATION'],
    },
    {
      name: 'a successor at the exact expiry',
      start: 7,
      end: 7,
      licenceFrom: 7,
      qpFrom: 7,
      due: [],
    },
    {
      name: 'an overlapping renewal',
      start: 3,
      end: 3,
      licenceFrom: 3,
      qpFrom: 3,
      due: [],
    },
    {
      name: 'a delayed licence validity start',
      start: 3,
      end: 3,
      licenceFrom: 8,
      qpFrom: 3,
      due: ['BRANCH_LICENCE'],
    },
    {
      name: 'a delayed qualified-person validity start',
      start: 3,
      end: 3,
      licenceFrom: 3,
      qpFrom: 8,
      due: ['QUALIFIED_PERSON_REGISTRATION'],
    },
    {
      name: 'a gap between profile effective periods',
      start: 5,
      end: 3,
      licenceFrom: 5,
      qpFrom: 5,
      due: ['BRANCH_LICENCE', 'QUALIFIED_PERSON_REGISTRATION'],
    },
  ])('preserves continuous coverage with $name', async ({ start, end, licenceFrom, qpFrom, due }) => {
    const id = `branch_ren720_future_${randomBytes(5).toString('hex')}`;
    await asOwner(async (owner) => {
      await owner.query(
        `INSERT INTO pharmacy_branches
           (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
         VALUES ($1, $2, $1, 'Future renewal', '1 Test Road', 'Lahore', 'PB', now())`,
        [id, orgA]
      );
      await owner.query(PROFILE_INSERT, [
        `${id}_v1`,
        orgA,
        id,
        1,
        inDays(-700),
        inDays(end),
        'DSL-CURRENT',
        inDays(7),
        inDays(7),
      ]);
      await owner.query(
        `INSERT INTO pharmacy_branch_regulatory_profiles
           (id, "organizationId", "branchId", version, "effectiveFrom", "provinceCode",
            "jurisdictionRuleSetId", premises, "licenceCategory", "licenceNumber",
            "licenceValidFrom", "licenceValidTo", "licenceEvidenceFileRef", "permittedSchedules",
            "qualifiedPersonRegistration", "qualifiedPersonValidFrom", "qualifiedPersonValidTo",
            "qualifiedPersonCoverageRosterRef", "fiscalStatus", "retentionPolicy")
         VALUES ($1, $2, $3, 2, $4, 'PK-PB', 'pk_pb_provisional_v1', '{}',
           'PHARMACY', 'DSL-FUTURE', $5, $6, 'file', ARRAY[]::text[],
           'QP-FUTURE', $7, $6, 'roster', 'UNCONFIRMED', '{}')`,
        [`${id}_v2`, orgA, id, inDays(start), inDays(licenceFrom), inDays(730), inDays(qpFrom)]
      );
    });
    const reminders = (await read(orgA, [id])).filter((reminder) => reminder.branchId === id);
    expect(reminders.map((reminder) => reminder.kind).sort()).toEqual([...due].sort());
    for (const reminder of reminders) {
      expect(reminder).toMatchObject({ stage: 7, expiresAt: new Date(inDays(7)) });
      expect(reminder.reference).toBe(reminder.kind === 'BRANCH_LICENCE' ? 'DSL-CURRENT' : 'QP-1');
    }
    // Every reminder channel consumes these same subjects.
    expect(renderRenewalDigest(reminders)).toHaveLength(due.length ? due.length + 1 : 0);
    if (start > 7) {
      const expired = (await read(orgA, [id], new Date(inDays(8)))).filter(
        (reminder) => reminder.branchId === id
      );
      expect(expired).toHaveLength(2);
      expect(expired.every((reminder) => reminder.expired)).toBe(true);
      const renewed = (await read(orgA, [id], new Date(inDays(start)))).filter(
        (reminder) => reminder.branchId === id
      );
      expect(renewed).toEqual([]);
    }
  });

  it('does not skip an intermediate future coverage gap to reach a distant renewal', async () => {
    const id = `branch_ren720_chain_${suffix}`;
    await asOwner(async (owner) => {
      await owner.query(
        `INSERT INTO pharmacy_branches
           (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
         VALUES ($1, $2, $1, 'Renewal chain', '1 Test Road', 'Lahore', 'PB', now())`,
        [id, orgA]
      );
      for (const [version, start, end, expiry] of [
        [1, -700, 7, 7],
        [2, 7, 40, 30],
        [3, 40, null, 730],
      ] as const) {
        await owner.query(PROFILE_INSERT, [
          `${id}_v${version}`,
          orgA,
          id,
          version,
          inDays(start),
          end === null ? null : inDays(end),
          `DSL-V${version}`,
          inDays(expiry),
          inDays(expiry),
        ]);
      }
    });
    const reminders = (await read(orgA, [id])).filter((reminder) => reminder.branchId === id);
    expect(reminders).toHaveLength(2);
    expect(reminders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'BRANCH_LICENCE', reference: 'DSL-V2', stage: 30 }),
        expect.objectContaining({ kind: 'QUALIFIED_PERSON_REGISTRATION', stage: 30 }),
      ])
    );
  });

  it('keeps independent wholesale licences separate and follows only explicit verified renewals', async () => {
    const supplierId = `supplier_ren720_independent_${suffix}`;
    const shortId = `${supplierId}_short`;
    const longId = `${supplierId}_long`;
    const insert = async (
      id: string,
      reference: string,
      days: number,
      verified: boolean,
      supersedesId: string | null
    ) =>
      asOwner(async (owner) => {
        await owner.query(
          `INSERT INTO pharmacy_supplier_licences
           (id, "organizationId", "supplierId", "licenceType", "licenceNumber", "issuingAuthority",
            "issuedAt", "expiresAt", "verifiedAt", "supersedesId")
         VALUES ($1, $2, $3, 'WHOLESALE', $4, 'Test authority', $5, $6, $7, $8)`,
          [
            id,
            orgA,
            supplierId,
            reference,
            inDays(-700),
            inDays(days),
            verified ? iso(NOW) : null,
            supersedesId,
          ]
        );
      });
    await asOwner(async (owner) => {
      await owner.query(
        `INSERT INTO pharmacy_suppliers (id, "organizationId", name, authorized, "updatedAt")
         VALUES ($1, $2, $1, true, now())`,
        [supplierId, orgA]
      );
    });
    const subjects = () =>
      deps.withTenantDb(orgA, (db) =>
        deps.operations.readLicenceRenewalSubjects(db, { organizationId: orgA, branchIds: [], at: NOW })
      );
    const supplierReminders = async () =>
      (await read(orgA, [])).filter(
        (reminder) => reminder.subjectId === shortId || reminder.subjectId === longId
      );
    await insert(shortId, 'WS-SHORT', 7, true, null);
    await insert(longId, 'WS-LONG', 730, true, null);
    expect(
      (await subjects()).filter((subject) => [shortId, longId].includes(subject.subjectId))
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectId: shortId, reference: 'WS-SHORT' }),
        expect.objectContaining({ subjectId: longId, reference: 'WS-LONG' }),
      ])
    );
    const due = await supplierReminders();
    expect(due).toEqual([
      expect.objectContaining({ subjectId: shortId, reference: 'WS-SHORT', stage: 7 }),
    ]);
    expect(renderRenewalDigest(due).join('\n')).toContain('WS-SHORT');

    // Renewing the independent long-dated licence must leave the short one due.
    await insert(`${longId}_renewed`, 'WS-LONG-NEW', 800, true, longId);
    expect(await supplierReminders()).toEqual(due);
    await insert(`${shortId}_pending`, 'WS-SHORT-PENDING', 730, false, shortId);
    expect(await supplierReminders()).toEqual(due);

    // A verified correction can shorten validity, and its root identity stays stable.
    await insert(`${shortId}_corrected`, 'WS-SHORT-CORRECTED', 3, true, `${shortId}_pending`);
    expect(await supplierReminders()).toEqual([
      expect.objectContaining({ subjectId: shortId, reference: 'WS-SHORT-CORRECTED', daysLeft: 3 }),
    ]);
    await insert(`${shortId}_renewed`, 'WS-SHORT-NEW', 730, true, `${shortId}_corrected`);
    expect(await supplierReminders()).toEqual([]);
    expect(await subjects()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subjectId: shortId, reference: 'WS-SHORT-NEW' }),
        expect.objectContaining({ subjectId: longId, reference: 'WS-LONG-NEW' }),
      ])
    );
  });

  it('reminds about a branch licence expiring in 30 days and a supplier licence at 7 days', async () => {
    const reminders = await read(orgA, [branchA]);
    expect(
      reminders.map(({ kind, reference, stage, branchId }) => ({ kind, reference, stage, branchId }))
    ).toEqual([
      { kind: 'SUPPLIER_LICENCE', reference: 'WS-1', stage: 7, branchId: null },
      { kind: 'BRANCH_LICENCE', reference: 'DSL-OLD', stage: 30, branchId: branchA },
    ]);
    expect(reminders[1]!.checklist.fee).toBe('Rs 3,000 (pharmacy)');
  });

  it('never reads another tenant’s licences, even when its branch id is asked for', async () => {
    const reminders = await read(orgA, [branchA, branchB]);
    expect(reminders.some((reminder) => reminder.reference === 'DSL-B')).toBe(false);
  });

  it('keeps reminding about the verified supplier licence while its renewal is unverified', async () => {
    await asOwner(async (owner) => {
      await owner.query(
        `INSERT INTO pharmacy_supplier_licences
           (id, "organizationId", "supplierId", "licenceType", "licenceNumber",
            "issuingAuthority", "issuedAt", "expiresAt", "supersedesId")
         VALUES ($1, $2, $3, 'WHOLESALE', 'WS-PENDING', 'Test authority', now(), $4, $5)`,
        [`licence_ren720_pending_${suffix}`, orgA, supplierA, inDays(730), `licence_ren720_a1_${suffix}`]
      );
    });
    const reminders = await read(orgA, [branchA]);
    expect(reminders.filter((reminder) => reminder.kind === 'SUPPLIER_LICENCE')).toEqual([
      expect.objectContaining({ reference: 'WS-1', stage: 7 }),
    ]);
  });

  it('stops the reminders once the renewed licences are saved and the supplier renewal is verified', async () => {
    await asOwner(async (owner) => {
      // Saved the way the regulatory profile form saves a new version.
      await owner.query(
        `UPDATE pharmacy_branch_regulatory_profiles SET "effectiveTo" = $1 WHERE id = $2`,
        [iso(NOW), `profile_ren720_a1_${suffix}`]
      );
      await owner.query(PROFILE_INSERT, [
        `profile_ren720_a2_${suffix}`,
        orgA,
        branchA,
        2,
        iso(NOW),
        null,
        'DSL-NEW',
        inDays(730),
        inDays(400),
      ]);
      await owner.query(
        `INSERT INTO pharmacy_supplier_licences
           (id, "organizationId", "supplierId", "licenceType", "licenceNumber",
            "issuingAuthority", "issuedAt", "expiresAt", "verifiedAt", "supersedesId")
         VALUES ($1, $2, $3, 'WHOLESALE', 'WS-2', 'Test authority', now(), $4, now(), $5)`,
        [`licence_ren720_a2_${suffix}`, orgA, supplierA, inDays(730), `licence_ren720_a1_${suffix}`]
      );
    });
    await expect(read(orgA, [branchA])).resolves.toEqual([]);
  });
});
