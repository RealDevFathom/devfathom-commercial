/**
 * PH-MIG / MIG-03, MIG-04, MIG-05 against migrated PostgreSQL with FORCED row
 * level security.
 *
 * These cases only mean anything against a real database. "A missing value is
 * never defaulted" is a CHECK; "opening totals are append-only" is a trigger;
 * "rollback loses no cutover-window transactions" is a property of an
 * append-only event log plus the rows it does NOT touch; and the cross-tenant
 * cases are RLS predicates. A mocked client would assert that the code calls
 * Prisma, not that any of those hold. Skipped (never silently passed) when the
 * database URL is absent.
 *
 * The runtime role is asserted NOSUPERUSER/NOBYPASSRLS first: with either
 * attribute the tenant cases would read straight through every policy and pass
 * for the wrong reason.
 *
 * TWO STRUCTURAL RULES, both inherited from the INV-01..04 suite and both
 * load-bearing here:
 *
 *   1. EVERY TEST GETS ITS OWN BRANCH (`scenario()`). Opening totals, parallel
 *      run windows, cutover ownership and the first-close verdict are all
 *      BRANCH-wide facts, so two tests sharing a branch would read each other's
 *      cutover events and each other's comparisons.
 *   2. AN EXPECTED DATABASE ERROR GETS ITS OWN TRANSACTION. A failed statement
 *      aborts the whole PostgreSQL transaction, so a test that provokes a
 *      trigger and then reads back must do the read from a new one.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1188_a_${suffix}`;
const ORG_B = `org_wha1188_b_${suffix}`;
const ACTOR = `user_migration_lead_${suffix}`;
const SIGNER = `user_inventory_manager_${suffix}`;

/** Fixed instants, so no case depends on the wall clock. */
const OPENING_AT = new Date('2026-09-01T04:00:00.000Z');
const EXPIRY = new Date('2027-06-01T00:00:00.000Z');
const BUSINESS_DATE = new Date('2026-09-01T00:00:00.000Z');
const WINDOW_START = new Date('2026-09-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-09-30T00:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  assertRlsEnforcingRole: (typeof import('@/lib/testing/rls-role-guard'))['assertRlsEnforcingRole'];
  opening: typeof import('./opening-stock');
  parallelRun: typeof import('./parallel-run');
  cutover: typeof import('./cutover');
  firstClose: typeof import('./first-close');
  settlement: typeof import('../settlement');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

type Scenario = {
  organizationId: string;
  branchId: string;
  medicineId: string;
  presentationId: string;
  packLevelId: string;
  locationId: string;
};

/** A private branch, catalog and location for one test. */
async function scenario(label: string, organizationId = ORG_A): Promise<Scenario> {
  const branchId = `branch_${tag(label)}`;
  return inOrg(organizationId, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: `Branch ${label}`,
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    if (organizationId === ORG_A)
      await db.pharmacyBranchAssignment.create({
        data: { organizationId, branchId, userId: SIGNER },
      });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Paracetamol 500mg ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId, presentation: 'Tablet, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${tag(label)}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId,
        code: `MAIN-${tag(label)}`,
        name: 'Main store',
        kind: 'STORE',
      },
    });
    return {
      organizationId,
      branchId,
      medicineId: medicine.id,
      presentationId: medicine.presentations[0]!.id,
      packLevelId: packLevel.id,
      locationId: location.id,
    };
  });
}

function scopeOf(fixture: Scenario, actorId = ACTOR) {
  return { organizationId: fixture.organizationId, branchId: fixture.branchId, actorId };
}

/** A manufacturing batch to hang an opening lot on. */
async function manufacturingBatch(db: ScopedDb, fixture: Scenario, label: string) {
  return db.pharmacyManufacturingBatch.create({
    data: {
      organizationId: fixture.organizationId,
      medicineId: fixture.medicineId,
      batchNumber: `B-${tag(label)}`,
      expiresAt: EXPIRY,
      expiryPrecision: 'DAY',
    },
  });
}

/** Every required attribute present, ready to post. */
function completeLine(
  fixture: Scenario,
  batchId: string,
  label: string,
  counted: number,
  expected = counted
) {
  return {
    sourceRef: `ABZ-${tag(label)}`,
    manufacturingBatchId: batchId,
    batchNumber: `B-${label}`,
    expiryDate: EXPIRY,
    expiryPrecision: 'MONTH' as const,
    printedMrpMinor: 25_000,
    unitCostMinor: 18_000,
    stockLocationId: fixture.locationId,
    packLevelId: fixture.packLevelId,
    unitsPerPack: 10,
    expectedUnits: expected,
    countedUnits: counted,
  };
}

/** Run one statement that is EXPECTED to fail, in its own transaction. */
async function expectRejection(
  organizationId: string,
  work: (db: ScopedDb) => Promise<unknown>
): Promise<string> {
  try {
    await inOrg(organizationId, work);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the statement to be rejected, but it succeeded.');
}

/**
 * Is the named append-only trigger installed on this table?
 *
 * WHY A CATALOG ASSERTION AND NOT A PROVOKED ERROR. The append-only tables carry
 * SELECT and INSERT policies only, and FORCE ROW LEVEL SECURITY subjects the
 * table owner too. An UPDATE or DELETE from any role this suite may legitimately
 * connect as is therefore filtered to ZERO ROWS before a row trigger could fire,
 * so the trigger's exception is unreachable from here. The guarantee is proved
 * the way the MIG-01/02 workbench suite proves the same thing: the mutation
 * changes nothing (asserted at the call site) AND the second guard is installed
 * for the connections policies cannot constrain (asserted here).
 */
async function appendOnlyTriggerInstalled(
  db: ScopedDb,
  table: string,
  trigger: string
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ present: bigint }>>`
    SELECT count(*)::bigint AS present
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = ${table} AND t.tgname = ${trigger} AND NOT t.tgisinternal`;
  return Number(rows[0]!.present) === 1;
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;

  const [scopedDb, roleGuard, opening, parallelRun, cutover, firstClose, settlement] =
    await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('@/lib/testing/rls-role-guard'),
      import('./opening-stock'),
      import('./parallel-run'),
      import('./cutover'),
      import('./first-close'),
      import('../settlement'),
    ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    assertRlsEnforcingRole: roleGuard.assertRlsEnforcingRole,
    opening,
    parallelRun,
    cutover,
    firstClose,
    settlement,
  };
  await deps.assertRlsEnforcingRole(scopedDb.withPlatformDb);

  await deps.withPlatformDb(async (db) => {
    await db.organization.createMany({
      data: [ORG_A, ORG_B].map((id, index) => ({
        id,
        slug: `wha1188-${index === 0 ? 'a' : 'b'}-${suffix}`,
        legalName: `PH-MIG ${index === 0 ? 'A' : 'B'}`,
        displayName: `PH-MIG ${index === 0 ? 'A' : 'B'}`,
        status: 'ACTIVE' as const,
        vertical: 'PHARMACY' as const,
        deploymentMode: 'SHARED' as const,
      })),
      skipDuplicates: true,
    });
  });
  await inOrg(ORG_A, async (db) => {
    await db.organizationDepartment.create({ data: { key: 'pharmacy', name: 'Pharmacy' } });
    const role = await db.organizationRole.create({
      data: { key: 'manager', name: 'Inventory manager' },
    });
    await db.organizationRolePermission.create({
      data: { organizationRoleId: role.id, capability: 'pharmacy:inventory' },
    });
    await db.user.create({
      data: {
        id: SIGNER,
        name: 'Independent inventory checker',
        email: `${suffix}-checker@example.invalid`,
        department: 'pharmacy',
        title: 'Manager',
        organizationRoleId: role.id,
      },
    });
  });
}, 120_000);

describeIfDatabase('MIG-03 — opening stock is never defaulted', () => {
  it('keeps a missing batch, expiry, MRP, cost, location or source ref as an exception', async () => {
    const fixture = await scenario('gaps');
    await inOrg(fixture.organizationId, async (db) => {
      const session = await deps.opening.createOpeningSession(db, scopeOf(fixture), {
        openingAt: OPENING_AT,
      });
      const batch = await manufacturingBatch(db, fixture, 'gaps');

      const { line, gaps } = await deps.opening.draftLine(db, scopeOf(fixture), {
        sessionId: session.id,
        ...completeLine(fixture, batch.id, 'gaps', 40),
        // The incumbent supplied no expiry and no MRP for this row.
        expiryDate: null,
        expiryPrecision: null,
        printedMrpMinor: null,
      });

      expect(gaps.sort()).toEqual(['MISSING_EXPIRY', 'MISSING_MRP']);
      expect(line.status).toBe('EXCEPTION');

      // The gap is stored as a gap. Nothing invented a value.
      const stored = await db.pharmacyOpeningStockLine.findFirstOrThrow({
        where: { organizationId: fixture.organizationId, id: line.id },
      });
      expect(stored.expiryDate).toBeNull();
      expect(stored.printedMrpMinor).toBeNull();

      // And the exception naming each gap was written in the same transaction.
      const exceptions = await db.pharmacyOpeningException.findMany({
        where: { organizationId: fixture.organizationId, lineId: line.id },
        orderBy: { bucket: 'asc' },
      });
      expect(exceptions.map((row) => row.bucket)).toEqual(['MISSING_EXPIRY', 'MISSING_MRP']);
    });
  });

  it('refuses at the database to mark an incomplete line POSTED', async () => {
    const fixture = await scenario('check');
    const lineId = await inOrg(fixture.organizationId, async (db) => {
      const session = await deps.opening.createOpeningSession(db, scopeOf(fixture), {
        openingAt: OPENING_AT,
      });
      const batch = await manufacturingBatch(db, fixture, 'check');
      const { line } = await deps.opening.draftLine(db, scopeOf(fixture), {
        sessionId: session.id,
        ...completeLine(fixture, batch.id, 'check', 40),
        unitCostMinor: null,
      });
      return line.id;
    });

    // The service is not the only guard: writing the status directly is refused
    // by the CHECK, so a caller that bypasses this module still cannot post a
    // lot whose cost the incumbent never supplied.
    const message = await expectRejection(fixture.organizationId, (db) =>
      db.pharmacyOpeningStockLine.update({
        where: { organizationId_id: { organizationId: fixture.organizationId, id: lineId } },
        data: { status: 'POSTED' },
      })
    );
    expect(message).toContain('pharmacy_opening_stock_lines_complete_before_post_check');
  });

  it('skips incomplete lines when posting instead of defaulting them', async () => {
    const fixture = await scenario('mixed');
    await inOrg(fixture.organizationId, async (db) => {
      const session = await deps.opening.createOpeningSession(db, scopeOf(fixture), {
        openingAt: OPENING_AT,
      });
      const [good, bad] = await Promise.all([
        manufacturingBatch(db, fixture, 'mixed-good'),
        manufacturingBatch(db, fixture, 'mixed-bad'),
      ]);
      await deps.opening.draftLine(db, scopeOf(fixture), {
        sessionId: session.id,
        ...completeLine(fixture, good.id, 'mixed-good', 40),
      });
      await deps.opening.draftLine(db, scopeOf(fixture), {
        sessionId: session.id,
        ...completeLine(fixture, bad.id, 'mixed-bad', 25),
        batchNumber: null,
        manufacturingBatchId: null,
      });

      const { total, postedLineCount } = await deps.opening.postOpeningSession(
        db,
        scopeOf(fixture),
        { sessionId: session.id, idempotencyKeyPrefix: `open-${tag('mixed')}` }
      );

      expect(postedLineCount).toBe(1);
      expect(total.totalUnits).toBe(40);
      expect(total.totalValueMinor).toBe(BigInt(40 * 18_000));
    });
  });
});

describeIfDatabase('MIG-03 — posting opening stock', () => {
  it('creates OPENING lots and movements and signed opening totals per branch', async () => {
    const fixture = await scenario('post');
    await inOrg(fixture.organizationId, async (db) => {
      const session = await deps.opening.createOpeningSession(db, scopeOf(fixture), {
        openingAt: OPENING_AT,
      });
      const batch = await manufacturingBatch(db, fixture, 'post');
      await deps.opening.draftLine(db, scopeOf(fixture), {
        sessionId: session.id,
        ...completeLine(fixture, batch.id, 'post', 45),
      });

      const { total } = await deps.opening.postOpeningSession(db, scopeOf(fixture), {
        sessionId: session.id,
        idempotencyKeyPrefix: `open-${tag('post')}`,
      });

      const movements = await db.pharmacyStockMovement.findMany({
        where: {
          organizationId: fixture.organizationId,
          branchId: fixture.branchId,
          kind: 'OPENING',
        },
      });
      expect(movements).toHaveLength(1);
      expect(movements[0]!.quantityUnits).toBe(45);
      // 45 units at 10 per pack is four sealed strips and five loose tablets.
      expect(movements[0]!.sealedPackDelta).toBe(4);
      expect(movements[0]!.looseUnitDelta).toBe(5);
      expect(movements[0]!.occurredAt).toEqual(OPENING_AT);

      // Opening stock is on the shelf, so the projection holds it and the ledger
      // will move it — an unreceived lot would be refused by INV-03.
      const balance = await db.pharmacyStockBalance.findFirstOrThrow({
        where: {
          organizationId: fixture.organizationId,
          branchId: fixture.branchId,
          disposition: 'AVAILABLE',
        },
      });
      expect(balance.onHandUnits).toBe(45);

      expect(total.totalUnits).toBe(45);
      expect(total.totalValueMinor).toBe(BigInt(45 * 18_000));
      expect(total.actorId).toBe(ACTOR);
    });
  });

  it('keeps opening totals append-only', async () => {
    const fixture = await scenario('immutable');
    const totalId = await inOrg(fixture.organizationId, async (db) => {
      const session = await deps.opening.createOpeningSession(db, scopeOf(fixture), {
        openingAt: OPENING_AT,
      });
      const batch = await manufacturingBatch(db, fixture, 'immutable');
      await deps.opening.draftLine(db, scopeOf(fixture), {
        sessionId: session.id,
        ...completeLine(fixture, batch.id, 'immutable', 10),
      });
      const { total } = await deps.opening.postOpeningSession(db, scopeOf(fixture), {
        sessionId: session.id,
        idempotencyKeyPrefix: `open-${tag('immutable')}`,
      });
      return total.id;
    });

    await inOrg(fixture.organizationId, async (db) => {
      // Guard one: no UPDATE or DELETE policy, so the statement matches nothing.
      const updated = await db.pharmacyOpeningTotal.updateMany({
        where: { organizationId: fixture.organizationId, id: totalId },
        data: { totalUnits: 999 },
      });
      const deleted = await db.pharmacyOpeningTotal.deleteMany({
        where: { organizationId: fixture.organizationId, id: totalId },
      });
      expect([updated.count, deleted.count]).toEqual([0, 0]);

      // Guard two, for connections a policy cannot constrain.
      expect(
        await appendOnlyTriggerInstalled(
          db,
          'pharmacy_opening_totals',
          'pharmacy_opening_totals_append_only'
        )
      ).toBe(true);

      // The row is untouched by either attempt.
      const stored = await db.pharmacyOpeningTotal.findFirstOrThrow({
        where: { organizationId: fixture.organizationId, id: totalId },
      });
      expect(stored.totalUnits).toBe(10);
    });
  });

  it('posts opening AP/AR/cash/bank as signed totals with actor and time', async () => {
    const fixture = await scenario('ledger');
    await inOrg(fixture.organizationId, async (db) => {
      const session = await deps.opening.createOpeningSession(db, scopeOf(fixture), {
        openingAt: OPENING_AT,
      });

      const ledger = await deps.opening.postOpeningLedger(db, scopeOf(fixture), {
        sessionId: session.id,
        balances: [
          // Payables are a credit balance, so they are negative.
          { account: 'ACCOUNTS_PAYABLE', balanceMinor: BigInt(-4_250_000), sourceRef: 'AP-01' },
          { account: 'ACCOUNTS_RECEIVABLE', balanceMinor: BigInt(1_100_000), sourceRef: 'AR-01' },
          { account: 'CASH', balanceMinor: BigInt(90_000), sourceRef: 'CASH-01' },
          { account: 'BANK', balanceMinor: BigInt(15_500_000), sourceRef: 'BANK-01' },
        ],
      });

      // PostgreSQL orders an enum column by DECLARATION order, not alphabetically,
      // so this is AP, AR, CASH, BANK — the order the accounts are declared in.
      expect(ledger.map((row) => [row.account, row.balanceMinor])).toEqual([
        ['ACCOUNTS_PAYABLE', BigInt(-4_250_000)],
        ['ACCOUNTS_RECEIVABLE', BigInt(1_100_000)],
        ['CASH', BigInt(90_000)],
        ['BANK', BigInt(15_500_000)],
      ]);
      for (const row of ledger) {
        expect(row.actorId).toBe(ACTOR);
        expect(row.postedAt).toBeInstanceOf(Date);
      }
    });
  });

  it('hides one tenant’s opening totals from another', async () => {
    const fixture = await scenario('tenant');
    await inOrg(fixture.organizationId, async (db) => {
      const session = await deps.opening.createOpeningSession(db, scopeOf(fixture), {
        openingAt: OPENING_AT,
      });
      const batch = await manufacturingBatch(db, fixture, 'tenant');
      await deps.opening.draftLine(db, scopeOf(fixture), {
        sessionId: session.id,
        ...completeLine(fixture, batch.id, 'tenant', 20),
      });
      await deps.opening.postOpeningSession(db, scopeOf(fixture), {
        sessionId: session.id,
        idempotencyKeyPrefix: `open-${tag('tenant')}`,
      });
    });

    const visibleToB = await inOrg(ORG_B, (db) =>
      db.pharmacyOpeningTotal.count({ where: { branchId: fixture.branchId } })
    );
    expect(visibleToB).toBe(0);
  });
});

describeIfDatabase('MIG-03 — variance and sign-off', () => {
  it('computes variance against the D05 threshold and refuses sign-off while it is unexplained', async () => {
    const fixture = await scenario('variance');
    const sessionId = await inOrg(fixture.organizationId, async (db) => {
      const session = await deps.opening.createOpeningSession(db, scopeOf(fixture), {
        openingAt: OPENING_AT,
      });
      const batch = await manufacturingBatch(db, fixture, 'variance');
      // The incumbent claimed 50; the shelf held 44.
      await deps.opening.draftLine(db, scopeOf(fixture), {
        sessionId: session.id,
        ...completeLine(fixture, batch.id, 'variance', 44, 50),
      });
      await deps.opening.postOpeningSession(db, scopeOf(fixture), {
        sessionId: session.id,
        idempotencyKeyPrefix: `open-${tag('variance')}`,
      });
      return session.id;
    });

    await inOrg(fixture.organizationId, async (db) => {
      // Default D05 threshold is zero, so a six-unit variance is material.
      const report = await deps.opening.openingVarianceReport(db, scopeOf(fixture), sessionId);
      expect(report.threshold.thresholdMinor).toBe(BigInt(0));
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]!.varianceUnits).toBe(-6);
      expect(report.rows[0]!.varianceValueMinor).toBe(BigInt(-6 * 18_000));
      expect(report.rows[0]!.material).toBe(true);
      expect(report.rows[0]!.explained).toBe(false);
      expect(report.reconciled).toBe(false);

      // MIG-03 acceptance: zero unexplained material variance AT SIGN-OFF.
      await expect(
        deps.opening.signOffOpeningSession(db, scopeOf(fixture, SIGNER), sessionId)
      ).rejects.toMatchObject({ reason: 'UNEXPLAINED_VARIANCE' });
    });

    await inOrg(fixture.organizationId, async (db) => {
      const report = await deps.opening.openingVarianceReport(db, scopeOf(fixture), sessionId);
      await deps.opening.explainVariance(db, scopeOf(fixture), {
        lineId: report.rows[0]!.lineId,
        note: 'Six tablets damaged in transit from the incumbent store; witnessed.',
      });

      const explained = await deps.opening.openingVarianceReport(db, scopeOf(fixture), sessionId);
      expect(explained.unexplainedMaterialCount).toBe(0);
      expect(explained.reconciled).toBe(true);

      const signed = await deps.opening.signOffOpeningSession(
        db,
        scopeOf(fixture, SIGNER),
        sessionId
      );
      expect(signed.status).toBe('SIGNED_OFF');
      expect(signed.signedOffBy).toBe(SIGNER);
    });
  });

  it('a raised threshold makes a small variance immaterial', async () => {
    const fixture = await scenario('threshold');
    await inOrg(fixture.organizationId, async (db) => {
      // D05 set by contract: variances up to 10 units are not material.
      await deps.opening.setMaterialityThreshold(db, scopeOf(fixture), {
        thresholdMinor: BigInt(200_000),
        thresholdUnits: 10,
      });

      const session = await deps.opening.createOpeningSession(db, scopeOf(fixture), {
        openingAt: OPENING_AT,
      });
      const batch = await manufacturingBatch(db, fixture, 'threshold');
      await deps.opening.draftLine(db, scopeOf(fixture), {
        sessionId: session.id,
        ...completeLine(fixture, batch.id, 'threshold', 48, 50),
      });
      await deps.opening.postOpeningSession(db, scopeOf(fixture), {
        sessionId: session.id,
        idempotencyKeyPrefix: `open-${tag('threshold')}`,
      });

      const report = await deps.opening.openingVarianceReport(db, scopeOf(fixture), session.id);
      expect(report.rows[0]!.varianceUnits).toBe(-2);
      expect(report.rows[0]!.material).toBe(false);
      expect(report.reconciled).toBe(true);

      // Sign-off is co-authored: the pharmacist who opened it cannot sign it.
      await expect(
        deps.opening.signOffOpeningSession(db, scopeOf(fixture), session.id)
      ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    });
  });
});

describeIfDatabase('MIG-04 — parallel run comparison', () => {
  it('compares operator-entered legacy totals against this system and flags the diff', async () => {
    const fixture = await scenario('compare');
    await inOrg(fixture.organizationId, async (db) => {
      const window = await deps.parallelRun.openParallelRunWindow(db, scopeOf(fixture), {
        startDate: WINDOW_START,
        endDate: WINDOW_END,
      });

      await deps.parallelRun.recordLegacyTotals(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
        legacySalesMinor: BigInt(75_000),
        legacyCashMinor: BigInt(0),
        legacyStockValueMinor: BigInt(0),
      });

      const comparisons = await deps.parallelRun.compareBusinessDate(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
      });

      const sales = comparisons.find((row) => row.metric === 'SALES')!;
      // This branch recorded no sales, so the whole legacy figure is the diff.
      expect(sales.devfathomMinor).toBe(BigInt(0));
      expect(sales.legacyMinor).toBe(BigInt(75_000));
      expect(sales.diffMinor).toBe(BigInt(-75_000));
      expect(sales.material).toBe(true);
      expect(sales.explained).toBe(false);

      const reconciliation = await deps.parallelRun.parallelRunReconciliation(
        db,
        scopeOf(fixture),
        window.id
      );
      expect(reconciliation.unexplainedCount).toBe(1);
      expect(reconciliation.reconciled).toBe(false);
    });
  });

  it('refuses to mark a comparison explained without a note', async () => {
    const fixture = await scenario('note');
    const comparisonId = await inOrg(fixture.organizationId, async (db) => {
      const window = await deps.parallelRun.openParallelRunWindow(db, scopeOf(fixture), {
        startDate: WINDOW_START,
        endDate: WINDOW_END,
      });
      await deps.parallelRun.recordLegacyTotals(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
        legacySalesMinor: BigInt(1_000),
        legacyCashMinor: BigInt(0),
        legacyStockValueMinor: BigInt(0),
      });
      const comparisons = await deps.parallelRun.compareBusinessDate(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
      });
      return comparisons.find((row) => row.metric === 'SALES')!.id;
    });

    // The service refuses a blank note...
    await inOrg(fixture.organizationId, async (db) => {
      await expect(
        deps.parallelRun.explainComparison(db, scopeOf(fixture), {
          comparisonId,
          note: '   ',
        })
      ).rejects.toMatchObject({ reason: 'NOTE_REQUIRED' });
    });

    // ...and so does the database, for a caller that skips the service.
    const message = await expectRejection(fixture.organizationId, (db) =>
      db.pharmacyParallelRunComparison.update({
        where: { organizationId_id: { organizationId: fixture.organizationId, id: comparisonId } },
        data: { explained: true },
      })
    );
    expect(message).toContain('explained_needs_note');
  });

  it('a restated comparison drops the explanation it no longer covers', async () => {
    const fixture = await scenario('restate');
    await inOrg(fixture.organizationId, async (db) => {
      const window = await deps.parallelRun.openParallelRunWindow(db, scopeOf(fixture), {
        startDate: WINDOW_START,
        endDate: WINDOW_END,
      });
      await deps.parallelRun.recordLegacyTotals(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
        legacySalesMinor: BigInt(50_000),
        legacyCashMinor: BigInt(0),
        legacyStockValueMinor: BigInt(0),
      });
      const first = await deps.parallelRun.compareBusinessDate(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
      });
      const salesId = first.find((row) => row.metric === 'SALES')!.id;
      await deps.parallelRun.explainComparison(db, scopeOf(fixture), {
        comparisonId: salesId,
        note: 'Counter two was still keying into the incumbent only.',
      });

      // The operator corrects the legacy figure and the comparison is restated.
      await deps.parallelRun.recordLegacyTotals(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
        legacySalesMinor: BigInt(60_000),
        legacyCashMinor: BigInt(0),
        legacyStockValueMinor: BigInt(0),
      });
      const second = await deps.parallelRun.compareBusinessDate(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
      });
      const restated = second.find((row) => row.metric === 'SALES')!;

      expect(restated.diffMinor).toBe(BigInt(-60_000));
      // The old note explained the old numbers, not these.
      expect(restated.explained).toBe(false);
      expect(restated.note).toBeNull();
    });
  });
});

describeIfDatabase('MIG-04 — cutover, sequence ownership and rollback', () => {
  it('the incumbent owns receipt numbering until a cutover takes it', async () => {
    const fixture = await scenario('own');
    await inOrg(fixture.organizationId, async (db) => {
      expect(await deps.cutover.receiptSequenceOwner(db, scopeOf(fixture))).toBe('LEGACY');

      const archive = await deps.cutover.recordLegacyArchive(db, scopeOf(fixture), {
        label: 'Abuzar final backup',
        storageLocation: 's3://legacy/abuzar-final.bak',
        bytes: `archive-${tag('own')}`,
      });
      await deps.cutover.cutOver(db, scopeOf(fixture), {
        effectiveAt: new Date('2026-09-10T00:00:00.000Z'),
        rollbackDeadline: new Date('2026-09-17T00:00:00.000Z'),
        legacyArchiveId: archive.id,
        reason: 'Go live after a clean parallel run.',
      });

      expect(await deps.cutover.receiptSequenceOwner(db, scopeOf(fixture))).toBe('DEVFATHOM');
    });
  });

  it('requires an immutable legacy archive reference, and keeps it immutable', async () => {
    const fixture = await scenario('archive');
    const archiveId = await inOrg(fixture.organizationId, async (db) => {
      await expect(
        deps.cutover.cutOver(db, scopeOf(fixture), {
          effectiveAt: new Date('2026-09-10T00:00:00.000Z'),
          rollbackDeadline: new Date('2026-09-17T00:00:00.000Z'),
          legacyArchiveId: `missing_${suffix}`,
          reason: 'No archive taken.',
        })
      ).rejects.toMatchObject({ reason: 'ARCHIVE_REQUIRED' });

      const bytes = `archive-${tag('archive')}`;
      const archive = await deps.cutover.recordLegacyArchive(db, scopeOf(fixture), {
        label: 'Abuzar final backup',
        storageLocation: '/mnt/vault/abuzar-final.bak',
        bytes,
      });
      expect(archive.contentHash).toMatch(/^[0-9a-f]{64}$/);

      // The same bytes are the same archive, not a second identity for one file.
      const again = await deps.cutover.recordLegacyArchive(db, scopeOf(fixture), {
        label: 'Abuzar final backup (re-registered)',
        storageLocation: '/mnt/vault/elsewhere.bak',
        bytes,
      });
      expect(again.id).toBe(archive.id);
      expect(again.storageLocation).toBe('/mnt/vault/abuzar-final.bak');
      return archive.id;
    });

    await inOrg(fixture.organizationId, async (db) => {
      const updated = await db.pharmacyLegacyArchive.updateMany({
        where: { organizationId: fixture.organizationId, id: archiveId },
        data: { storageLocation: 'somewhere else' },
      });
      expect(updated.count).toBe(0);
      expect(
        await appendOnlyTriggerInstalled(
          db,
          'pharmacy_legacy_archives',
          'pharmacy_legacy_archives_append_only'
        )
      ).toBe(true);

      const stored = await db.pharmacyLegacyArchive.findFirstOrThrow({
        where: { organizationId: fixture.organizationId, id: archiveId },
      });
      expect(stored.storageLocation).toBe('/mnt/vault/abuzar-final.bak');
    });
  });

  /** MIG-04 acceptance: "Rollback loses no cutover-window transactions". */
  it('rollback re-opens legacy ownership without losing cutover-window transactions', async () => {
    const fixture = await scenario('rollback');
    const cutoverId = await inOrg(fixture.organizationId, async (db) => {
      const archive = await deps.cutover.recordLegacyArchive(db, scopeOf(fixture), {
        label: 'Pre-cutover archive',
        storageLocation: 's3://legacy/pre-cutover.bak',
        bytes: `archive-${tag('rollback')}`,
      });
      const cutover = await deps.cutover.cutOver(db, scopeOf(fixture), {
        effectiveAt: new Date('2026-09-10T00:00:00.000Z'),
        rollbackDeadline: new Date('2026-09-17T00:00:00.000Z'),
        legacyArchiveId: archive.id,
        reason: 'Go live.',
      });

      // Three receipts issued while DevFathom owned the sequence.
      await db.pharmacyReceiptNumberSequence.create({
        data: {
          organizationId: fixture.organizationId,
          branchId: fixture.branchId,
          deviceId: `counter-${tag('rollback')}`,
          nextNumber: 4,
        },
      });
      for (const receiptNumber of [1, 2, 3]) {
        await db.pharmacySale.create({
          data: {
            organizationId: fixture.organizationId,
            branchId: fixture.branchId,
            status: 'COMPLETED',
            createdByUserId: ACTOR,
            receiptNumber,
            businessDate: new Date('2026-09-11T00:00:00.000Z'),
            completedAt: new Date('2026-09-11T09:00:00.000Z'),
            createdAt: new Date('2026-09-11T09:00:00.000Z'),
          },
        });
      }
      return cutover.id;
    });

    const before = await inOrg(fixture.organizationId, (db) =>
      deps.cutover.cutoverWindowTransactionCount(db, scopeOf(fixture), cutoverId)
    );
    expect(before).toBe(3);

    await inOrg(fixture.organizationId, async (db) => {
      await deps.cutover.rollBack(db, scopeOf(fixture), {
        at: new Date('2026-09-15T00:00:00.000Z'),
        reason: 'Counter staff not ready; returning to the incumbent.',
      });

      // Ownership is back with the incumbent...
      expect(await deps.cutover.receiptSequenceOwner(db, scopeOf(fixture))).toBe('LEGACY');

      // ...and nothing issued during the window was lost. The sales are still
      // there, still numbered, and the sequence was not rewound.
      const after = await deps.cutover.cutoverWindowTransactionCount(
        db,
        scopeOf(fixture),
        cutoverId
      );
      expect(after).toBe(3);

      const sales = await db.pharmacySale.findMany({
        where: { organizationId: fixture.organizationId, branchId: fixture.branchId },
        orderBy: { receiptNumber: 'asc' },
      });
      expect(sales.map((sale) => sale.receiptNumber)).toEqual([1, 2, 3]);

      const sequence = await db.pharmacyReceiptNumberSequence.findFirstOrThrow({
        where: { organizationId: fixture.organizationId, branchId: fixture.branchId },
      });
      expect(sequence.nextNumber).toBe(4);

      // Rollback APPENDED; it did not edit the cutover.
      const history = await deps.cutover.cutoverHistory(db, scopeOf(fixture));
      expect(history.map((row) => row.kind)).toEqual(['CUTOVER', 'ROLLBACK']);
    });
  });

  it('keeps the ownership log append-only', async () => {
    const fixture = await scenario('appendonly');
    const cutoverId = await inOrg(fixture.organizationId, async (db) => {
      const archive = await deps.cutover.recordLegacyArchive(db, scopeOf(fixture), {
        label: 'Archive',
        storageLocation: 's3://legacy/a.bak',
        bytes: `archive-${tag('appendonly')}`,
      });
      const cutover = await deps.cutover.cutOver(db, scopeOf(fixture), {
        effectiveAt: new Date('2026-09-10T00:00:00.000Z'),
        rollbackDeadline: new Date('2026-09-17T00:00:00.000Z'),
        legacyArchiveId: archive.id,
        reason: 'Go live.',
      });
      return cutover.id;
    });

    await inOrg(fixture.organizationId, async (db) => {
      // Flipping ownership by editing the log, and erasing the log, both change
      // nothing — which is precisely why ownership is safe to read as a fold.
      const updated = await db.pharmacyCutoverEvent.updateMany({
        where: { organizationId: fixture.organizationId, id: cutoverId },
        data: { sequenceOwner: 'LEGACY' },
      });
      const deleted = await db.pharmacyCutoverEvent.deleteMany({
        where: { organizationId: fixture.organizationId, id: cutoverId },
      });
      expect([updated.count, deleted.count]).toEqual([0, 0]);

      expect(
        await appendOnlyTriggerInstalled(
          db,
          'pharmacy_cutover_events',
          'pharmacy_cutover_events_append_only'
        )
      ).toBe(true);

      // Ownership still reads DEVFATHOM: neither attempt reached the log.
      expect(await deps.cutover.receiptSequenceOwner(db, scopeOf(fixture))).toBe('DEVFATHOM');
    });
  });

  it('refuses a rollback after the window has expired', async () => {
    const fixture = await scenario('expired');
    await inOrg(fixture.organizationId, async (db) => {
      const archive = await deps.cutover.recordLegacyArchive(db, scopeOf(fixture), {
        label: 'Archive',
        storageLocation: 's3://legacy/b.bak',
        bytes: `archive-${tag('expired')}`,
      });
      await deps.cutover.cutOver(db, scopeOf(fixture), {
        effectiveAt: new Date('2026-09-10T00:00:00.000Z'),
        rollbackDeadline: new Date('2026-09-17T00:00:00.000Z'),
        legacyArchiveId: archive.id,
        reason: 'Go live.',
      });

      await expect(
        deps.cutover.rollBack(db, scopeOf(fixture), {
          at: new Date('2026-09-18T00:00:00.000Z'),
          reason: 'Too late.',
        })
      ).rejects.toMatchObject({ reason: 'ROLLBACK_WINDOW_EXPIRED' });

      // Ownership is unchanged by a refused rollback.
      expect(await deps.cutover.receiptSequenceOwner(db, scopeOf(fixture))).toBe('DEVFATHOM');
    });
  });
});

describeIfDatabase('MIG-05 — the first close is final only once legacy totals reconcile', () => {
  it('is final for a branch that never ran in parallel', async () => {
    const fixture = await scenario('nomig');
    await inOrg(fixture.organizationId, async (db) => {
      const verdict = await deps.firstClose.firstCloseVerdict(
        db,
        fixture.organizationId,
        fixture.branchId
      );
      expect(verdict).toMatchObject({ isFinal: true, reason: 'NO_PARALLEL_RUN' });
    });
  });

  it('is not final while a parallel run has no comparisons at all', async () => {
    const fixture = await scenario('nocmp');
    await inOrg(fixture.organizationId, async (db) => {
      await deps.parallelRun.openParallelRunWindow(db, scopeOf(fixture), {
        startDate: WINDOW_START,
        endDate: WINDOW_END,
      });
      const verdict = await deps.firstClose.firstCloseVerdict(
        db,
        fixture.organizationId,
        fixture.branchId
      );
      expect(verdict).toMatchObject({ isFinal: false, reason: 'NO_COMPARISONS_YET' });
    });
  });

  it('is false while a material variance is unexplained and true once it is explained', async () => {
    const fixture = await scenario('gate');
    await inOrg(fixture.organizationId, async (db) => {
      const window = await deps.parallelRun.openParallelRunWindow(db, scopeOf(fixture), {
        startDate: WINDOW_START,
        endDate: WINDOW_END,
      });
      await deps.parallelRun.recordLegacyTotals(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
        legacySalesMinor: BigInt(42_000),
        legacyCashMinor: BigInt(0),
        legacyStockValueMinor: BigInt(0),
      });
      const comparisons = await deps.parallelRun.compareBusinessDate(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
      });

      expect(
        await deps.firstClose.firstCloseIsFinal(db, fixture.organizationId, fixture.branchId)
      ).toBe(false);

      for (const comparison of comparisons.filter((row) => row.material)) {
        await deps.parallelRun.explainComparison(db, scopeOf(fixture), {
          comparisonId: comparison.id,
          note: 'Incumbent total included a counter that DevFathom had not enrolled yet.',
        });
      }

      expect(
        await deps.firstClose.firstCloseIsFinal(db, fixture.organizationId, fixture.branchId)
      ).toBe(true);
    });
  });

  /** The one integration point: POS-B's daily close consults the helper. */
  it('the daily close records the verdict on the close it cuts', async () => {
    const fixture = await scenario('close');
    await inOrg(fixture.organizationId, async (db) => {
      const window = await deps.parallelRun.openParallelRunWindow(db, scopeOf(fixture), {
        startDate: WINDOW_START,
        endDate: WINDOW_END,
      });
      await deps.parallelRun.recordLegacyTotals(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
        legacySalesMinor: BigInt(33_000),
        legacyCashMinor: BigInt(0),
        legacyStockValueMinor: BigInt(0),
      });
      const comparisons = await deps.parallelRun.compareBusinessDate(db, scopeOf(fixture), {
        windowId: window.id,
        businessDate: BUSINESS_DATE,
      });

      // Legacy totals do not reconcile yet, so the close is not final.
      const provisional = await deps.settlement.cutPharmacyDailyClose(db, scopeOf(fixture), {
        businessDate: BUSINESS_DATE,
      });
      expect(provisional.isFinal).toBe(false);

      for (const comparison of comparisons.filter((row) => row.material)) {
        await deps.parallelRun.explainComparison(db, scopeOf(fixture), {
          comparisonId: comparison.id,
          note: 'Legacy figure included the previous day’s late entries.',
        });
      }

      // Re-cutting the same date once the run reconciles produces a final close.
      const final = await deps.settlement.cutPharmacyDailyClose(db, scopeOf(fixture), {
        businessDate: BUSINESS_DATE,
        reopenReason: 'Parallel run reconciled; restating the close as final.',
      });
      expect(final.isFinal).toBe(true);
      expect(final.sequence).toBe(2);
      expect(final.supersedesCloseId).toBe(provisional.id);
    });
  });
});
