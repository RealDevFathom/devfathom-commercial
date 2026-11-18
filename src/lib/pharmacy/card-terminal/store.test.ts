import { beforeEach, describe, expect, it, vi } from 'vitest';

const settlement = vi.hoisted(() => ({ applyPharmacyTender: vi.fn() }));
vi.mock('../settlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settlement')>()),
  applyPharmacyTender: settlement.applyPharmacyTender,
}));

import { Prisma } from '@/generated/prisma/client';
import { PharmacySettlementError } from '../settlement';
import {
  approvedChargeReplay,
  cardTerminalAuditEntry,
  preflightTerminalCharge,
  prismaCardTerminalAttemptStore,
  type CardTerminalAttempt,
} from './store';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
const draft = {
  saleId: 'sale-1',
  deviceId: 'device-1',
  terminalId: 'counter-1',
  provider: 'FAKE_TERMINAL',
  attemptKey: 'sale-1:card:0001',
  amountMinor: 1500,
  currency: 'PKR',
  businessDate: new Date('2026-11-18T00:00:00.000Z'),
};
const attempt = (patch: Partial<CardTerminalAttempt> = {}): CardTerminalAttempt => ({
  id: 'attempt-1',
  organizationId: 'org-1',
  branchId: 'branch-1',
  ...draft,
  status: 'APPROVED',
  providerRef: 'RRN-1',
  approvalCode: null,
  cardBrand: null,
  cardLast4: null,
  declineCode: null,
  statusChecks: 0,
  tenderId: null,
  reviewReason: null,
  resolvedById: null,
  resolutionReason: null,
  resolutionRef: null,
  actorId: 'cashier-1',
  sentAt: new Date(),
  resolvedAt: null,
  createdAt: new Date(),
  ...patch,
});

function fakeDb() {
  const calls: string[] = [];
  const sql = (value: unknown) => (value as { strings: string[] }).strings.join('?');
  const db = {
    calls,
    $executeRaw: vi.fn(async (query: unknown) => {
      calls.push(sql(query));
      return 0;
    }),
    $queryRaw: vi.fn(async (query: unknown) => {
      calls.push(sql(query));
      return [];
    }),
    // No close stands on the business day.
    pharmacyDailyClose: { findFirst: vi.fn(async () => null) },
    pharmacyCardTerminalAttempt: {
      findFirst: vi.fn(),
      create: vi.fn(async ({ data }: { data: object }) => {
        calls.push('create');
        // The database's defaults: a new attempt is CREATED with no checks.
        return { id: 'attempt-1', status: 'CREATED', statusChecks: 0, ...data };
      }),
      update: vi.fn(async ({ data }: { data: object }) => {
        calls.push('update');
        return { ...attempt(), ...data };
      }),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
    // DEV-743: every committed attempt change writes its audit entry in the same transaction.
    auditLog: {
      create: vi.fn<(query: { data: Record<string, unknown> }) => Promise<object>>(async () => {
        calls.push('audit');
        return {};
      }),
    },
  };
  return db;
}
const runner = (db: ReturnType<typeof fakeDb>, actor?: 'USER' | 'SYSTEM') =>
  prismaCardTerminalAttemptStore(<T>(work: (tx: never) => Promise<T>) => work(db as never), actor);

beforeEach(() => {
  settlement.applyPharmacyTender.mockReset();
});

describe('DEV-743 durable attempt store', () => {
  it('runs every real tender guard and rolls back its writes before committing the attempt', async () => {
    const db = fakeDb();
    db.pharmacyCardTerminalAttempt.findFirst.mockResolvedValue(null);
    settlement.applyPharmacyTender.mockImplementation(
      async (_db, _scope, tender, _auth, options) => {
        db.calls.push('applyPharmacyTender');
        expect(tender).toMatchObject({ saleId: 'sale-1', type: 'CARD', amountMinor: 1500 });
        expect(options).toEqual({ requireCurrentBusinessDate: true });
        // Settlement reaches the provider only after its guards: the preflight stops it there.
        await tender.adapter.execute({ capability: 'SALE', amountMinor: 1500, operationRef: 'x' });
        throw new Error('unreachable');
      }
    );
    const result = await runner(db).create(scope, draft);
    expect(result).toMatchObject({ created: true, attempt: { id: 'attempt-1' } });
    expect(db.calls).toEqual([
      expect.stringContaining('FROM pharmacy_sales'),
      'SAVEPOINT card_terminal_preflight',
      'applyPharmacyTender',
      'ROLLBACK TO SAVEPOINT card_terminal_preflight',
      // The savepoint rollback released the preflight's day lock: it is taken again to commit.
      expect.stringContaining('pg_advisory_xact_lock'),
      'create',
      'audit',
    ]);
    expect(db.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      action: 'pharmacyCardTerminal.attempt.created',
      operation: 'CREATE',
      actorType: 'USER',
      actorId: 'cashier-1',
    });
    expect(db.pharmacyCardTerminalAttempt.create).toHaveBeenCalledWith({
      data: { organizationId: 'org-1', branchId: 'branch-1', ...draft, actorId: 'cashier-1' },
    });
  });

  it('writes no attempt when a tender guard refuses the sale', async () => {
    const db = fakeDb();
    db.pharmacyCardTerminalAttempt.findFirst.mockResolvedValue(null);
    const refusal = new PharmacySettlementError('OVER_TENDER');
    settlement.applyPharmacyTender.mockRejectedValue(refusal);
    await expect(runner(db).create(scope, draft)).rejects.toBe(refusal);
    expect(db.calls.at(-1)).toBe('ROLLBACK TO SAVEPOINT card_terminal_preflight');
    expect(db.pharmacyCardTerminalAttempt.create).not.toHaveBeenCalled();
  });

  it('commits no attempt when the day closed after the preflight released its day lock', async () => {
    const db = fakeDb();
    db.pharmacyCardTerminalAttempt.findFirst.mockResolvedValue(null);
    // A close cut while the preflight's savepoint was rolled back (that releases its day lock).
    db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-1', reopen: null } as never);
    settlement.applyPharmacyTender.mockImplementation(async (_db, _scope, tender) => {
      await tender.adapter.execute({ capability: 'SALE', amountMinor: 1500, operationRef: 'x' });
    });
    await expect(runner(db).create(scope, draft)).rejects.toMatchObject({ reason: 'DAY_CLOSED' });
    expect(db.calls.at(-1)).toEqual(expect.stringContaining('pg_advisory_xact_lock'));
    expect(db.pharmacyCardTerminalAttempt.create).not.toHaveBeenCalled();
  });

  it("reads the sale's newest attempt within the branch", async () => {
    const db = fakeDb();
    const latest = attempt({ status: 'UNKNOWN', providerRef: null });
    db.pharmacyCardTerminalAttempt.findFirst.mockResolvedValueOnce(latest);
    await expect(runner(db).latestForSale(scope, 'sale-1')).resolves.toBe(latest);
    expect(db.pharmacyCardTerminalAttempt.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', branchId: 'branch-1', saleId: 'sale-1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('undoes and refuses a preflight that somehow wrote a tender', async () => {
    const db = fakeDb();
    db.pharmacyCardTerminalAttempt.findFirst.mockResolvedValue(null);
    settlement.applyPharmacyTender.mockResolvedValue({ tenderId: 'tender-x' });
    await expect(preflightTerminalCharge(db as never, scope, draft)).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    expect(db.calls.at(-1)).toBe('ROLLBACK TO SAVEPOINT card_terminal_preflight');
  });

  it('replays an existing key and refuses a different payload or an open attempt', async () => {
    const db = fakeDb();
    const existing = attempt({ status: 'CREATED', providerRef: null });
    db.pharmacyCardTerminalAttempt.findFirst.mockResolvedValueOnce(existing);
    await expect(runner(db).create(scope, draft)).resolves.toEqual({
      created: false,
      attempt: existing,
    });
    db.pharmacyCardTerminalAttempt.findFirst.mockResolvedValueOnce(existing);
    await expect(runner(db).create(scope, { ...draft, amountMinor: 1 })).rejects.toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    db.pharmacyCardTerminalAttempt.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'open' });
    await expect(
      runner(db).create(scope, { ...draft, attemptKey: 'sale-1:card:0002' })
    ).rejects.toMatchObject({ reason: 'ATTEMPT_IN_PROGRESS' });
    expect(settlement.applyPharmacyTender).not.toHaveBeenCalled();
    expect(db.pharmacyCardTerminalAttempt.create).not.toHaveBeenCalled();
  });

  it('settles under the sale then attempt lock with a replay that never reaches a terminal', async () => {
    const db = fakeDb();
    db.pharmacyCardTerminalAttempt.findFirst
      .mockResolvedValueOnce({ saleId: 'sale-1' })
      .mockResolvedValueOnce(attempt());
    settlement.applyPharmacyTender.mockImplementation(async (_db, _scope, tender) => {
      db.calls.push('applyPharmacyTender');
      expect(tender).toMatchObject({
        saleId: 'sale-1',
        deviceId: 'device-1',
        type: 'CARD',
        amountMinor: 1500,
        idempotencyKey: 'card-terminal:attempt-1',
        adapter: { name: 'FAKE_TERMINAL', certified: true },
      });
      await expect(
        tender.adapter.execute({ capability: 'SALE', amountMinor: 1500, operationRef: 'k' })
      ).resolves.toEqual({ approved: true, providerRef: 'RRN-1' });
      return { tenderId: 'tender-1', settled: true };
    });
    await expect(runner(db).settle(scope, 'attempt-1')).resolves.toEqual({
      tenderId: 'tender-1',
      replayed: false,
    });
    expect(db.calls).toEqual([
      expect.stringContaining('FROM pharmacy_sales'),
      expect.stringContaining('FROM pharmacy_card_terminal_attempts'),
      'applyPharmacyTender',
      'update',
      'audit',
    ]);
    expect(db.auditLog.create.mock.calls[0]![0].data).toMatchObject({
      action: 'pharmacyCardTerminal.attempt.settled',
      targetId: 'attempt-1',
      metadata: { from: 'APPROVED', to: 'SETTLED', tenderId: 'tender-1', branchId: 'branch-1' },
    });
    expect(db.pharmacyCardTerminalAttempt.update).toHaveBeenCalledWith({
      where: { id: 'attempt-1' },
      data: { status: 'SETTLED', tenderId: 'tender-1', resolvedAt: expect.any(Date) },
    });
  });

  it('returns the recorded tender for a settled attempt and refuses one not approved or not in PKR', async () => {
    const db = fakeDb();
    db.pharmacyCardTerminalAttempt.findFirst
      .mockResolvedValueOnce({ saleId: 'sale-1' })
      .mockResolvedValueOnce(attempt({ status: 'SETTLED', tenderId: 'tender-1' }))
      .mockResolvedValueOnce({ saleId: 'sale-1' })
      .mockResolvedValueOnce(attempt({ status: 'UNKNOWN', providerRef: null }))
      .mockResolvedValueOnce({ saleId: 'sale-1' })
      .mockResolvedValueOnce(attempt({ currency: 'USD' }));
    await expect(runner(db).settle(scope, 'attempt-1')).resolves.toEqual({
      tenderId: 'tender-1',
      replayed: true,
    });
    await expect(runner(db).settle(scope, 'attempt-1')).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    // Tenders post in PKR with no conversion: a charge in another currency never becomes one.
    await expect(runner(db).settle(scope, 'attempt-1')).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    expect(settlement.applyPharmacyTender).not.toHaveBeenCalled();
  });

  it('transitions by compare-and-set on status and check count within the branch', async () => {
    const db = fakeDb();
    db.pharmacyCardTerminalAttempt.updateMany.mockResolvedValueOnce({ count: 0 });
    const current = attempt({ status: 'UNKNOWN', providerRef: null, statusChecks: 2 });
    await expect(
      runner(db).transition(scope, current, { status: 'UNKNOWN', statusChecks: 3 })
    ).resolves.toBeNull();
    expect(db.pharmacyCardTerminalAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        id: 'attempt-1',
        status: 'UNKNOWN',
        statusChecks: 2,
      },
      data: { status: 'UNKNOWN', statusChecks: 3 },
    });
    // The loser of the compare-and-set writes no audit entry.
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('writes the winner’s audit entry in the transaction of its change, with no card data', async () => {
    const db = fakeDb();
    const current = attempt({ status: 'MANUAL_REVIEW', providerRef: null, reviewReason: 'Late' });
    db.pharmacyCardTerminalAttempt.updateMany.mockResolvedValueOnce({ count: 1 });
    db.pharmacyCardTerminalAttempt.findFirst.mockResolvedValueOnce(
      attempt({
        status: 'REVERSED',
        providerRef: 'RRN-9',
        cardBrand: 'VISA',
        cardLast4: '4242',
        approvalCode: 'A1B2',
        resolvedById: 'manager-1',
        resolutionReason: 'Customer was charged',
        resolutionRef: 'RRN-9',
      })
    );
    const approval = { policy: 'PHARMACY_CARD_TERMINAL_REVIEW_MANAGER_PIN', selfApproved: true };
    await runner(db).transition(scope, current, { status: 'REVERSED' }, approval);
    expect(db.calls).toEqual(['audit']);
    const entry = db.auditLog.create.mock.calls[0]![0].data;
    expect(entry).toMatchObject({
      organizationId: 'org-1',
      actorType: 'USER',
      source: 'TRPC',
      actorId: 'cashier-1',
      category: 'PHARMACY',
      action: 'pharmacyCardTerminal.attempt.reviewResolved',
      targetType: 'PharmacyCardTerminalAttempt',
      targetId: 'attempt-1',
      metadata: {
        ...approval,
        branchId: 'branch-1',
        from: 'MANUAL_REVIEW',
        to: 'REVERSED',
        resolvedById: 'manager-1',
        resolutionReason: 'Customer was charged',
        resolutionRef: 'RRN-9',
      },
    });
    expect(JSON.stringify(entry)).not.toMatch(/4242|VISA|A1B2|counter-1/);
  });

  it('audits the recovery sweep as the system, for the attempt’s cashier', () => {
    const entry = cardTerminalAuditEntry(
      attempt({ status: 'UNKNOWN', providerRef: null }),
      'SENT',
      'SYSTEM',
      scope
    );
    expect(entry).toMatchObject({
      actorType: 'SYSTEM',
      source: 'SYSTEM',
      action: 'pharmacyCardTerminal.attempt.unknown',
      metadata: { onBehalfOfUserId: 'cashier-1', from: 'SENT', to: 'UNKNOWN' },
    });
    expect(entry).not.toHaveProperty('actorId');
    for (const [status, event] of [
      ['SENT', 'dispatched'],
      ['APPROVED', 'approved'],
      ['DECLINED', 'declined'],
      ['MANUAL_REVIEW', 'manualReview'],
      ['ABANDONED', 'abandoned'],
    ] as const)
      expect(cardTerminalAuditEntry(attempt({ status }), 'UNKNOWN', 'SYSTEM', scope).action).toBe(
        `pharmacyCardTerminal.attempt.${event}`
      );
  });

  it('refuses a slip reference already recorded on another terminal payment', async () => {
    const db = fakeDb();
    db.pharmacyCardTerminalAttempt.updateMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' })
    );
    await expect(
      runner(db).transition(scope, attempt({ status: 'MANUAL_REVIEW', providerRef: null }), {
        status: 'REVERSED',
        providerRef: 'RRN-1',
        resolutionRef: 'RRN-1',
      })
    ).rejects.toMatchObject({ reason: 'SLIP_REFERENCE_IN_USE' });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('replays only the stored approval, for the same sale amount', async () => {
    const replay = approvedChargeReplay(attempt());
    await expect(
      replay.execute({ capability: 'REFUND', amountMinor: 1500, operationRef: 'k' })
    ).resolves.toMatchObject({ approved: false });
    await expect(
      replay.execute({ capability: 'SALE', amountMinor: 1499, operationRef: 'k' })
    ).resolves.toMatchObject({ approved: false });
    await expect(
      approvedChargeReplay(attempt({ status: 'MANUAL_REVIEW' })).execute({
        capability: 'SALE',
        amountMinor: 1500,
        operationRef: 'k',
      })
    ).resolves.toMatchObject({ approved: false });
  });
});
