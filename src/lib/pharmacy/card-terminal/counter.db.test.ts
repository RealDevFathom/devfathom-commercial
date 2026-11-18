/**
 * @vitest-environment node
 *
 * DEV-743: the card-terminal counter flow against a REAL migrated PostgreSQL, through the real
 * Prisma store, service, settlement, day close and recovery sweep, each store call in its own
 * committed tenant transaction as the counter's requests run. Only the terminal is fake.
 *
 * - Two dispatches racing for one attempt: exactly one charge reaches the terminal.
 * - Two charges racing for one sale: exactly one attempt and one charge.
 * - A business day does not close while a terminal payment on it is open (application and
 *   database), and closes once the payment is recovered.
 * - The recovery sweep finds a stale attempt across tenants and settles it by status query.
 * - One terminal approval is at most one tender (unique provider reference).
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the restricted runtime
 * role (neither SUPERUSER nor BYPASSRLS, asserted first). Without it the suite reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; everything that reaches it is imported below.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Scope = { organizationId: string; branchId: string; actorId: string };
type Adapter = import('./contract').CardTerminalAdapter;
type Response = import('./contract').TerminalResponse;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let service: typeof import('./service');
let storeModule: typeof import('./store');
let sweep: typeof import('./sweep');
let settlement: typeof import('../settlement');
let sales: typeof import('../sales');
let ledger: typeof import('../stock-ledger');

const run = randomUUID().replaceAll('-', '').slice(0, 10);
const organizationId = `ct_counter_${run}`;
const branchMain = `ct_branch_main_${run}`;
const branchClose = `ct_branch_close_${run}`;
const actorId = `ct-cashier-${run}`;
const admission = { admittedProviders: ['FAKE_TERMINAL'] };
const ruleSetIds: string[] = [];
let businessDate: Date;
const stock: Record<string, { medicineId: string; presentationId: string; packLevelId: string }> =
  {};

const scopeOf = (branchId: string): Scope => ({ organizationId, branchId, actorId });
const tenant = <T>(work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(organizationId, work, { userId: actorId });

/** A terminal that answers each call from a script, after an optional gate opens. */
function gatedTerminal() {
  const charges: string[] = [];
  const queries: string[] = [];
  const chargeAnswers: Response[] = [];
  const queryAnswers: Response[] = [];
  let open: () => void = () => undefined;
  let gate = Promise.resolve();
  const adapter: Adapter & { simulated: true } = {
    name: 'FAKE_TERMINAL',
    simulated: true,
    async startCharge(request) {
      charges.push(request.operationRef);
      await gate;
      return (
        chargeAnswers.shift() ?? { kind: 'ERROR', code: 'UNSCRIPTED', reachedTerminal: 'UNKNOWN' }
      );
    },
    async queryStatus(request) {
      queries.push(request.operationRef);
      return queryAnswers.shift() ?? { kind: 'PENDING' };
    },
  };
  return {
    adapter,
    charges,
    queries,
    chargeAnswers,
    queryAnswers,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
  };
}

function depsFor(terminal: ReturnType<typeof gatedTerminal>) {
  return {
    store: storeModule.prismaCardTerminalAttemptStore((work) => tenant(work)),
    adapter: terminal.adapter,
    admission,
  };
}

async function setupBranch(branchId: string) {
  const scope = scopeOf(branchId);
  stock[branchId] = await tenant(async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: branchId,
        name: `Terminal ${branchId}`,
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Terminal medicine ${branchId}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: presentation.id,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: { organizationId, branchId, code: randomUUID(), name: 'Stock', kind: 'STORE' },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `CT-${branchId}`,
        expiresAt: new Date('2031-01-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    await ledger.receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: location.id,
      unitsPerPack: 10,
      supplierName: 'Test',
      supplierInvoiceRef: randomUUID(),
      unitCostMinor: 1,
      printedMrpMinor: 1000,
      receivedExpiresAt: new Date('2031-01-01T00:00:00.000Z'),
      receivedExpiryPrecision: 'DAY',
      quantityUnits: 500,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2026-01-01'),
    });
    return { medicineId: medicine.id, presentationId: presentation.id, packLevelId: pack.id };
  });
  ruleSetIds.push(await seedPharmacyRegulatoryProfile(withPlatformDb, tenant, branchId));
}

/** An open sale of ten units, 950 minor due. */
async function openSale(branchId: string) {
  const scope = scopeOf(branchId);
  const line = stock[branchId]!;
  return tenant(async (db) => {
    const sale = await sales.createSale(db, scope);
    await sales.addSaleLine(db, scope, {
      saleId: sale.id,
      ...line,
      saleUnit: 'UNIT',
      quantity: 10,
      canonicalUnitsPerSaleUnit: 1,
      discountMinor: 50,
      discountKind: 'DISCOUNT',
      approvedByUserId: actorId,
      approvalPolicy: 'test',
      idempotencyKey: randomUUID(),
    });
    return sale.id;
  });
}

const chargeInput = (saleId: string, attemptKey = `ct:${randomUUID()}`) => ({
  saleId,
  deviceId: 'counter-device-1',
  terminalId: 'paired-terminal-1',
  attemptKey,
  amountMinor: 950,
  currency: 'PKR',
  businessDate,
});

const attemptsFor = (saleId: string) =>
  tenant((db) => db.pharmacyCardTerminalAttempt.findMany({ where: { saleId } }));
const tendersFor = (saleId: string) =>
  tenant((db) => db.pharmacyTender.findMany({ where: { saleId } }));

const noop = () => undefined;

async function until(condition: () => boolean, label: string) {
  for (let tries = 0; tries < 400; tries += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  service = await import('./service');
  storeModule = await import('./store');
  sweep = await import('./sweep');
  settlement = await import('../settlement');
  sales = await import('../sales');
  ledger = await import('../stock-ledger');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  const { workspaceToday } = await import('@/lib/timezone');
  await assertRlsEnforcingRole(withPlatformDb);
  await withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  const organization = await withPlatformDb((db) =>
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } })
  );
  // A new terminal charge books on today, in the workspace zone.
  businessDate = new Date(`${workspaceToday(organization.timezone)}T00:00:00.000Z`);
  await setupBranch(branchMain);
  await setupBranch(branchClose);
}, 120_000);

afterAll(async () => {
  if (TEST_DATABASE_URL) await retirePharmacyRegulatoryRules(withPlatformDb, ruleSetIds);
});

describeDatabase('DEV-743 card-terminal counter flow on PostgreSQL', () => {
  const scope = () => scopeOf(branchMain);

  it('sends exactly one charge when two dispatches race for the same attempt', async () => {
    const saleId = await openSale(branchMain);
    const terminal = gatedTerminal();
    const deps = depsFor(terminal);
    const input = chargeInput(saleId);
    const begun = await service.beginCardTerminalCharge(deps, scope(), input);
    expect(begun).toMatchObject({ created: true, attempt: { status: 'CREATED' } });

    terminal.hold();
    terminal.chargeAnswers.push({
      kind: 'APPROVED',
      providerRef: `RRN-${run}-1`,
      amountMinor: 950,
    });
    const racing = Promise.all([
      service.dispatchCardTerminalCharge(deps, scope(), input.attemptKey),
      service.dispatchCardTerminalCharge(deps, scope(), input.attemptKey),
    ]);
    await until(() => terminal.charges.length >= 1, 'the winning dispatch');
    terminal.release();
    const results = await racing;

    expect(terminal.charges).toEqual([begun.attempt.id]);
    // The loser re-reads the winner's state; neither sent a second charge.
    expect(results.map((row) => row.status).sort()).toEqual(expect.arrayContaining(['SETTLED']));
    const [attempt] = await attemptsFor(saleId);
    expect(attempt).toMatchObject({ status: 'SETTLED', providerRef: `RRN-${run}-1` });
    const tenders = await tendersFor(saleId);
    expect(tenders).toEqual([
      expect.objectContaining({
        id: attempt!.tenderId,
        type: 'CARD',
        provider: 'FAKE_TERMINAL',
        providerRef: `RRN-${run}-1`,
        amountMinor: 950,
      }),
    ]);
  });

  it('commits one attempt and sends one charge when two charges race for one sale', async () => {
    const saleId = await openSale(branchMain);
    const terminal = gatedTerminal();
    const deps = depsFor(terminal);
    terminal.hold();
    terminal.chargeAnswers.push({
      kind: 'APPROVED',
      providerRef: `RRN-${run}-2`,
      amountMinor: 950,
    });
    const charges = [
      service.chargeCardTerminal(deps, scope(), chargeInput(saleId)),
      service.chargeCardTerminal(deps, scope(), chargeInput(saleId)),
    ];
    // Hold the winner at the terminal until the loser has answered: it must see the open attempt.
    const firstSettled = Promise.race(charges.map((charge) => charge.then(noop, noop)));
    await Promise.race([firstSettled, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    terminal.release();
    const outcomes = await Promise.allSettled(charges);

    expect(terminal.charges).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      reason: 'ATTEMPT_IN_PROGRESS',
    });
    expect(await attemptsFor(saleId)).toEqual([expect.objectContaining({ status: 'SETTLED' })]);
    expect(await tendersFor(saleId)).toHaveLength(1);
  });

  it('keeps one tender per terminal approval, whatever sale it is offered to', async () => {
    const saleId = await openSale(branchMain);
    await expect(
      tenant((db) =>
        db.$executeRawUnsafe(
          `INSERT INTO pharmacy_tenders
             (id,"organizationId","branchId","saleId",type,"amountMinor",provider,"providerRef",
              "businessDate","actorId","deviceId")
           VALUES ($1,$2,$3,$4,'CARD',950,'FAKE_TERMINAL',$5,$6::date,$7,'counter-device-1')`,
          `dup_${run}`,
          organizationId,
          branchMain,
          saleId,
          `RRN-${run}-1`,
          businessDate.toISOString().slice(0, 10),
          actorId
        )
      )
    ).rejects.toMatchObject({ message: expect.stringMatching(/23505|unique/i) });
    const [index] = await tenant((db) =>
      db.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'pharmacy_tenders_terminal_provider_ref_key'`
      )
    );
    // Manual slip references may repeat, so the manual providers stay outside the index.
    for (const name of ['MANUAL_TERMINAL', 'MANUAL_MERCHANT', 'CUSTOMER_PREPAID'])
      expect(index!.indexdef).toContain(`'${name}'`);
  });

  it('does not close a day while a terminal payment on it is open, and closes once recovered', async () => {
    const closeScope = scopeOf(branchClose);
    const saleId = await openSale(branchClose);
    // An unpaid bill does not hold the close; it stays open for the next day's check.
    const late = await openSale(branchClose);
    const terminal = gatedTerminal();
    const deps = depsFor(terminal);
    const input = chargeInput(saleId);
    terminal.chargeAnswers.push({ kind: 'ERROR', code: 'TIMEOUT', reachedTerminal: 'UNKNOWN' });
    await expect(service.chargeCardTerminal(deps, closeScope, input)).resolves.toMatchObject({
      status: 'UNKNOWN',
    });

    await expect(
      tenant((db) => settlement.cutPharmacyDailyClose(db, closeScope, { businessDate }))
    ).rejects.toMatchObject({ reason: 'CARD_TERMINAL_PAYMENT_OPEN' });
    // The database refuses the close row itself, whatever path writes it.
    await expect(
      tenant((db) =>
        db.$executeRawUnsafe(
          `INSERT INTO pharmacy_daily_closes
             (id,"organizationId","branchId","businessDate",sequence,"grossSalesMinor",
              "refundTotalMinor","netSalesMinor","cashExpectedMinor","cashCountedMinor",
              "cashVarianceMinor","sourceHash","actorId")
           VALUES ($1,$2,$3,$4::date,1,0,0,0,0,0,0,'hash',$5)`,
          `close_${run}`,
          organizationId,
          branchClose,
          businessDate.toISOString().slice(0, 10),
          actorId
        )
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'a card-terminal payment is still open on this business day'
      ),
    });
    expect(
      await tenant((db) => db.pharmacyDailyClose.count({ where: { branchId: branchClose } }))
    ).toBe(0);

    // A status check settles it on the same operation; then the day closes.
    terminal.queryAnswers.push({ kind: 'APPROVED', providerRef: `RRN-${run}-3`, amountMinor: 950 });
    await expect(
      service.recoverCardTerminalAttempt(deps, closeScope, input.attemptKey)
    ).resolves.toMatchObject({ status: 'SETTLED' });
    expect(terminal.charges).toHaveLength(1);
    await expect(
      tenant((db) => settlement.cutPharmacyDailyClose(db, closeScope, { businessDate }))
    ).resolves.toMatchObject({ branchId: branchClose, sequence: 1 });

    // A closed day takes no new terminal attempt.
    await expect(
      service.beginCardTerminalCharge(deps, closeScope, chargeInput(late))
    ).rejects.toMatchObject({ reason: 'DAY_CLOSED' });
    expect(await attemptsFor(late)).toEqual([]);
  });

  it('recovers a stale attempt from the scheduled sweep by status query, never a new charge', async () => {
    const saleId = await openSale(branchMain);
    const terminal = gatedTerminal();
    const deps = depsFor(terminal);
    const input = chargeInput(saleId);
    terminal.chargeAnswers.push({ kind: 'PENDING' });
    const unknown = await service.chargeCardTerminal(deps, scope(), input);
    expect(unknown.status).toBe('UNKNOWN');
    // The counter walked away ten minutes ago.
    await tenant((db) =>
      db.$executeRawUnsafe(
        `UPDATE pharmacy_card_terminal_attempts SET "updatedAt" = now() - interval '10 minutes'
         WHERE id = $1`,
        unknown.id
      )
    );
    terminal.queryAnswers.push({ kind: 'APPROVED', providerRef: `RRN-${run}-4`, amountMinor: 950 });
    const result = await sweep.processDueCardTerminalRecovery(new Date(), 500, {
      // Only this suite's tenant has a terminal; every other tenant's attempt is skipped.
      resolve: async (candidate) =>
        candidate.organizationId === organizationId
          ? { adapter: terminal.adapter, terminalId: 'paired-terminal-1', admission }
          : null,
    });
    expect(result.failed).toBe(0);
    expect(result.resolved).toBeGreaterThanOrEqual(1);
    expect(terminal.charges).toEqual([unknown.id]);
    expect(terminal.queries).toEqual([unknown.id]);
    expect(await attemptsFor(saleId)).toEqual([
      expect.objectContaining({ status: 'SETTLED', providerRef: `RRN-${run}-4` }),
    ]);
    expect(await tendersFor(saleId)).toHaveLength(1);
  });
});
