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
 * - A manager or owner resolves a manual review with their own PIN: two racing resolutions give
 *   exactly one, a cashier and a wrong PIN change nothing, and the day closes afterwards.
 * - Every committed attempt change keeps its audit entry, even when the request rolls back, and
 *   the sweep's entries name the system.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the restricted runtime
 * role (neither SUPERUSER nor BYPASSRLS, asserted first). Without it the suite reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// `@/lib/db` reads DATABASE_URL on first use; everything that reaches it is imported below.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;

// The router resolves its terminal through the registry; this suite hands it the fake one.
const registry = vi.hoisted(() => ({
  resolve: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('./registry', () => ({ resolvePharmacyCardTerminal: registry.resolve }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

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
let terminalRouter: typeof import('@/server/routers/pharmacy-card-terminal');

const run = randomUUID().replaceAll('-', '').slice(0, 10);
const organizationId = `ct_counter_${run}`;
const branchMain = `ct_branch_main_${run}`;
const branchClose = `ct_branch_close_${run}`;
const branchReview = `ct_branch_review_${run}`;
const actorId = `ct-cashier-${run}`;
/** A counter cashier: takes payments, never resolves a review. */
const cashierId = `ct-counter-cashier-${run}`;
/** A second manager, added by the last test: the pharmacy is then staffed. */
const managerId = `ct-manager-${run}`;
const secondManagerPin = '1357';
const managerPin = '2468';
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

/** The card-terminal procedures as the cashier calls them, on one request's transaction. */
function counterCaller(
  db: ScopedDb,
  user: { id: string; role: 'ADMIN' | 'EMPLOYEE' } = { id: actorId, role: 'ADMIN' }
) {
  return terminalRouter.pharmacyCardTerminalRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-core', 'pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: { id: user.id, role: user.role, status: 'ACTIVE', organizationId },
    },
    organization: { id: organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

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
  terminalRouter = await import('@/server/routers/pharmacy-card-terminal');
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
  await setupBranch(branchReview);
  // The counter cashier, with counter access on the main branch.
  const { seedDepartments } = await import('@/lib/test-support/departments');
  await tenant(async (db) => {
    await seedDepartments(db, [organizationId], ['LEADERSHIP']);
    await db.user.create({
      data: {
        id: actorId,
        name: 'Terminal cashier',
        email: `${actorId}@example.test`,
        department: 'LEADERSHIP',
        title: 'Cashier',
        role: 'ADMIN',
      },
    });
    await db.userPermissionOverride.create({
      data: { userId: actorId, capability: 'pharmacy:counter', effect: 'ALLOW', reason: 'DEV-743' },
    });
    await db.pharmacyBranchAssignment.create({ data: { userId: actorId, branchId: branchMain } });
    await db.pharmacyBranchAssignment.create({ data: { userId: actorId, branchId: branchReview } });
    // The owner manages the pharmacy (a cashier never does): the refund rule's grant.
    await db.userPermissionOverride.create({
      data: { userId: actorId, capability: 'pharmacy:manage', effect: 'ALLOW', reason: 'DEV-743' },
    });
    // The owner's own approval PIN: this workspace has no second manager (solo owner).
    const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
    const profile = await db.restaurantStaffProfile.create({
      data: { userId: actorId, displayName: 'Terminal owner' },
    });
    await db.restaurantOperatorCredential.create({
      data: {
        staffProfileId: profile.id,
        type: 'PIN',
        credentialHash: await hashOperatorCredential('PIN', managerPin),
      },
    });
    await db.user.create({
      data: {
        id: cashierId,
        name: 'Counter cashier',
        email: `${cashierId}@example.test`,
        department: 'LEADERSHIP',
        title: 'Cashier',
        role: 'EMPLOYEE',
      },
    });
    await db.userPermissionOverride.create({
      data: {
        userId: cashierId,
        capability: 'pharmacy:counter',
        effect: 'ALLOW',
        reason: 'DEV-743',
      },
    });
    await db.pharmacyBranchAssignment.create({ data: { userId: cashierId, branchId: branchMain } });
  });
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

  it('keeps the attempt and its tender when the counter request itself rolls back', async () => {
    const saleId = await openSale(branchMain);
    const terminal = gatedTerminal();
    terminal.chargeAnswers.push({
      kind: 'APPROVED',
      providerRef: `RRN-${run}-5`,
      amountMinor: 950,
    });
    registry.resolve.mockResolvedValue({
      adapter: terminal.adapter,
      terminalId: 'paired-terminal-1',
      admission,
    });
    const attemptKey = `ct:${randomUUID()}`;
    // The HTTP route runs each request inside one tenant transaction. Fail it after the charge:
    // every attempt step committed on its own, so the record of the money survives.
    await expect(
      withTenantDb(
        organizationId,
        async (db) => {
          const paid = await counterCaller(db).charge({
            branchId: branchMain,
            saleId,
            deviceId: 'counter-device-1',
            businessDate,
            amountMinor: 950,
            attemptKey,
          });
          expect(paid).toMatchObject({ phase: 'PAID', open: false });
          throw new Error('request rolled back');
        },
        { userId: actorId }
      )
    ).rejects.toThrow('request rolled back');
    expect(terminal.charges).toHaveLength(1);
    expect(await attemptsFor(saleId)).toEqual([
      expect.objectContaining({ attemptKey, status: 'SETTLED', providerRef: `RRN-${run}-5` }),
    ]);
    expect(await tendersFor(saleId)).toHaveLength(1);
    await expect(
      withTenantDb(
        organizationId,
        (db) => counterCaller(db).attempt({ branchId: branchMain, saleId }),
        {
          userId: actorId,
        }
      )
    ).resolves.toMatchObject({ attemptKey, phase: 'PAID' });
  });

  const auditFor = (attemptId: string) =>
    tenant((db) =>
      db.auditLog.findMany({
        where: { targetType: 'PharmacyCardTerminalAttempt', targetId: attemptId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    );
  const request = <T>(work: (db: ScopedDb) => Promise<T>) =>
    withTenantDb(organizationId, work, { userId: actorId });

  /** A charge the terminal approved for a different amount: a person must review it. */
  async function chargeIntoReview(branchId: string, providerRef: string) {
    const saleId = await openSale(branchId);
    const terminal = gatedTerminal();
    terminal.chargeAnswers.push({ kind: 'APPROVED', providerRef, amountMinor: 900 });
    const review = await service.chargeCardTerminal(
      depsFor(terminal),
      scopeOf(branchId),
      chargeInput(saleId)
    );
    expect(review).toMatchObject({ status: 'MANUAL_REVIEW', providerRef });
    return { saleId, review, terminal };
  }

  it('resolves a review exactly once when two resolutions race, and the day closes after', async () => {
    const reviewScope = scopeOf(branchReview);
    const { saleId, review } = await chargeIntoReview(branchReview, `RRN-${run}-6`);
    // The review holds the business day.
    await expect(
      tenant((db) => settlement.cutPharmacyDailyClose(db, reviewScope, { businessDate }))
    ).rejects.toMatchObject({ reason: 'CARD_TERMINAL_PAYMENT_OPEN' });

    const resolve = (reason: string) =>
      request((db) =>
        counterCaller(db).resolveReview({
          branchId: branchReview,
          attemptKey: review.attemptKey,
          outcome: 'REVERSED',
          resolutionReason: reason,
          slipRef: `RRN-${run}-6`,
          managerPin,
        })
      );
    const outcomes = await Promise.allSettled([
      resolve('Customer was charged, first'),
      resolve('Customer was charged, second'),
    ]);
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect((won[0] as PromiseFulfilledResult<unknown>).value).toMatchObject({
      phase: 'REVERSED',
      open: false,
    });
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CONFLICT',
      message: 'REVIEW_NOT_OPEN',
    });
    const [attempt] = await attemptsFor(saleId);
    expect(attempt).toMatchObject({
      status: 'REVERSED',
      resolvedById: actorId,
      resolutionRef: `RRN-${run}-6`,
      providerRef: `RRN-${run}-6`,
      tenderId: null,
    });
    // Money taken is recorded for a provider refund, never as a tender on the bill.
    expect(await tendersFor(saleId)).toEqual([]);
    const resolutions = (await auditFor(attempt!.id)).filter(
      (row) => row.action === 'pharmacyCardTerminal.attempt.reviewResolved'
    );
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      actorType: 'USER',
      actorId,
      metadata: expect.objectContaining({
        policy: 'PHARMACY_CARD_TERMINAL_REVIEW_MANAGER_PIN',
        pinVerified: true,
        // The owner took this charge, and nobody else active holds pharmacy:manage.
        initiatedById: actorId,
        approverId: actorId,
        selfApproved: true,
        soloOwner: true,
        from: 'MANUAL_REVIEW',
        to: 'REVERSED',
        branchId: branchReview,
      }),
    });
    expect(JSON.stringify(resolutions)).not.toContain(managerPin);

    // The sale may take another payment: a new terminal attempt starts, and is declined.
    const terminal = gatedTerminal();
    terminal.chargeAnswers.push({ kind: 'DECLINED', declineCode: '05' });
    await expect(
      service.chargeCardTerminal(depsFor(terminal), reviewScope, chargeInput(saleId))
    ).resolves.toMatchObject({ status: 'DECLINED' });
    // And the business day closes.
    await expect(
      tenant((db) => settlement.cutPharmacyDailyClose(db, reviewScope, { businessDate }))
    ).resolves.toMatchObject({ branchId: branchReview, sequence: 1 });
  });

  it('refuses a cashier and a wrong PIN, and leaves the review holding the sale', async () => {
    const { saleId, review } = await chargeIntoReview(branchMain, `RRN-${run}-7`);
    const resolution = {
      branchId: branchMain,
      attemptKey: review.attemptKey,
      outcome: 'REVERSED' as const,
      resolutionReason: 'Customer was charged',
      slipRef: `RRN-${run}-7`,
      managerPin,
    };
    await expect(
      withTenantDb(
        organizationId,
        (db) => counterCaller(db, { id: cashierId, role: 'EMPLOYEE' }).resolveReview(resolution),
        { userId: cashierId }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      request((db) => counterCaller(db).resolveReview({ ...resolution, managerPin: '1357' }))
    ).resolves.toMatchObject({ blocked: expect.any(String) });
    // "Nothing was charged" is refused for a charge the terminal reported.
    await expect(
      request((db) => counterCaller(db).resolveReview({ ...resolution, outcome: 'DECLINED' }))
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'CHARGE_EVIDENCE_RECORDED' });
    expect(await attemptsFor(saleId)).toEqual([
      expect.objectContaining({ status: 'MANUAL_REVIEW', resolvedById: null }),
    ]);
    const refused = await tenant((db) =>
      db.auditLog.findMany({
        where: {
          action: 'pharmacyCardTerminal.resolveReview',
          outcome: 'FAILURE',
          actorId,
          errorCode: 'CARD_TERMINAL_REVIEW_PIN_REFUSED',
        },
      })
    );
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // The owner resolves it, so the branch is left clean.
    await expect(
      request((db) => counterCaller(db).resolveReview(resolution))
    ).resolves.toMatchObject({ phase: 'REVERSED' });
  });

  it('keeps the audit entry of every committed attempt change when the request rolls back', async () => {
    const saleId = await openSale(branchMain);
    const terminal = gatedTerminal();
    terminal.chargeAnswers.push({
      kind: 'APPROVED',
      providerRef: `RRN-${run}-8`,
      amountMinor: 950,
    });
    registry.resolve.mockResolvedValue({
      adapter: terminal.adapter,
      terminalId: 'paired-terminal-1',
      admission,
    });
    const attemptKey = `ct:${randomUUID()}`;
    await expect(
      request(async (db) => {
        await counterCaller(db).charge({
          branchId: branchMain,
          saleId,
          deviceId: 'counter-device-1',
          businessDate,
          amountMinor: 950,
          attemptKey,
        });
        throw new Error('request rolled back');
      })
    ).rejects.toThrow('request rolled back');
    const [attempt] = await attemptsFor(saleId);
    const entries = await auditFor(attempt!.id);
    expect(entries.map((row) => row.action)).toEqual([
      'pharmacyCardTerminal.attempt.created',
      'pharmacyCardTerminal.attempt.dispatched',
      'pharmacyCardTerminal.attempt.approved',
      'pharmacyCardTerminal.attempt.settled',
    ]);
    for (const row of entries) {
      expect(row).toMatchObject({ actorType: 'USER', actorId, category: 'PHARMACY' });
      // No card data and no terminal id in an audit entry.
      expect(JSON.stringify(row.metadata)).not.toMatch(/paired-terminal-1|cardLast4|cardBrand/);
    }

    // The terminal-paid sale is never refunded from here, in cash or otherwise.
    for (const manualCashFallback of [true, false])
      await expect(
        tenant((db) =>
          settlement.refundPharmacyTender(db, scope(), {
            originalTenderId: attempt!.tenderId!,
            deviceId: 'counter-device-1',
            businessDate,
            amountMinor: 950,
            reason: 'Returned',
            idempotencyKey: `refund:${randomUUID()}`,
            manualCashFallback,
          })
        )
      ).rejects.toMatchObject({ reason: 'CARD_TERMINAL_REFUND_VIA_PROVIDER' });
    expect(await tenant((db) => db.pharmacyRefund.count({ where: { saleId } }))).toBe(0);
  });

  it('audits the sweep’s outcomes as the system, for the attempt’s cashier', async () => {
    const saleId = await openSale(branchMain);
    const terminal = gatedTerminal();
    terminal.chargeAnswers.push({ kind: 'PENDING' });
    const unknown = await service.chargeCardTerminal(
      depsFor(terminal),
      scope(),
      chargeInput(saleId)
    );
    await tenant((db) =>
      db.$executeRawUnsafe(
        `UPDATE pharmacy_card_terminal_attempts SET "updatedAt" = now() - interval '10 minutes'
         WHERE id = $1`,
        unknown.id
      )
    );
    terminal.queryAnswers.push({ kind: 'DECLINED', declineCode: '05' });
    await sweep.processDueCardTerminalRecovery(new Date(), 500, {
      resolve: async (candidate) =>
        candidate.organizationId === organizationId
          ? { adapter: terminal.adapter, terminalId: 'paired-terminal-1', admission }
          : null,
    });
    const declined = (await auditFor(unknown.id)).filter(
      (row) => row.action === 'pharmacyCardTerminal.attempt.declined'
    );
    expect(declined).toEqual([
      expect.objectContaining({
        actorType: 'SYSTEM',
        source: 'SYSTEM',
        actorId: null,
        metadata: expect.objectContaining({ onBehalfOfUserId: actorId, from: 'UNKNOWN' }),
      }),
    ]);
  });

  // Last: it adds a second manager, so the owner is no longer the only one who may resolve.
  it('in a staffed pharmacy, refuses a manager’s own charge and lets another manager resolve it', async () => {
    const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
    await tenant(async (db) => {
      await db.user.create({
        data: {
          id: managerId,
          name: 'Second manager',
          email: `${managerId}@example.test`,
          department: 'LEADERSHIP',
          title: 'Manager',
          role: 'EMPLOYEE',
        },
      });
      for (const capability of ['pharmacy:counter', 'pharmacy:manage'])
        await db.userPermissionOverride.create({
          data: { userId: managerId, capability, effect: 'ALLOW', reason: 'DEV-743' },
        });
      await db.pharmacyBranchAssignment.create({
        data: { userId: managerId, branchId: branchMain },
      });
      const profile = await db.restaurantStaffProfile.create({
        data: { userId: managerId, displayName: 'Second manager' },
      });
      await db.restaurantOperatorCredential.create({
        data: {
          staffProfileId: profile.id,
          type: 'PIN',
          credentialHash: await hashOperatorCredential('PIN', secondManagerPin),
        },
      });
    });
    // The owner took this charge.
    const { saleId, review } = await chargeIntoReview(branchMain, `RRN-${run}-9`);
    const resolution = {
      branchId: branchMain,
      attemptKey: review.attemptKey,
      outcome: 'REVERSED' as const,
      resolutionReason: 'Customer was charged',
      slipRef: `RRN-${run}-9`,
    };
    await expect(
      request((db) => counterCaller(db).resolveReview({ ...resolution, managerPin }))
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Another manager or owner must resolve a payment you took.',
    });
    // Nothing changed, and no PIN was asked (no refused-PIN audit row for the owner here).
    expect(await attemptsFor(saleId)).toEqual([
      expect.objectContaining({ status: 'MANUAL_REVIEW', resolvedById: null }),
    ]);
    expect(
      (await auditFor(review.id)).filter(
        (row) => row.action === 'pharmacyCardTerminal.attempt.reviewResolved'
      )
    ).toEqual([]);

    // The other manager resolves it with their own PIN.
    await expect(
      withTenantDb(
        organizationId,
        (db) =>
          counterCaller(db, { id: managerId, role: 'EMPLOYEE' }).resolveReview({
            ...resolution,
            managerPin: secondManagerPin,
          }),
        { userId: managerId }
      )
    ).resolves.toMatchObject({ phase: 'REVERSED', open: false });
    expect(await attemptsFor(saleId)).toEqual([
      expect.objectContaining({ status: 'REVERSED', actorId, resolvedById: managerId }),
    ]);
    const [resolved] = (await auditFor(review.id)).filter(
      (row) => row.action === 'pharmacyCardTerminal.attempt.reviewResolved'
    );
    expect(resolved).toMatchObject({
      actorId: managerId,
      metadata: expect.objectContaining({
        initiatedById: actorId,
        approverId: managerId,
        pinVerified: true,
        selfApproved: false,
        soloOwner: false,
      }),
    });
  });
});
