import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DEV-743 mocked end-to-end: scripted terminal → intent service → REAL
 * `applyPharmacyTender` (narrow fake database) → reconciliation.
 *
 * Everything is in-process. No provider SDK, device, network, credential or money.
 * Database-backed settlement suites remain the authority for SQL behaviour; this
 * suite proves the seam's ordering and fail-closed gates.
 */

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  assertSaleBatchesSellable: vi.fn(async () => new Map()),
  assertRxSaleAllowed: vi.fn(async () => undefined),
  postTenderEntry: vi.fn(async () => undefined),
  requestCounterEvidence: vi.fn(async () => undefined),
}));
vi.mock('../sale-batch-safety', () => ({
  assertSaleBatchesSellable: mocks.assertSaleBatchesSellable,
}));
vi.mock('../rx-sale-gate', () => ({ assertRxSaleAllowed: mocks.assertRxSaleAllowed }));
vi.mock('../counter-evidence', () => ({ requestCounterEvidence: mocks.requestCounterEvidence }));
vi.mock('../finance-postings', async (importActual) => ({
  ...(await importActual<typeof import('../finance-postings')>()),
  postTenderEntry: mocks.postTenderEntry,
}));

import { applyPharmacyTender } from '../settlement';
import { tenderIdempotencyKeyFor } from './intent';
import { reconcileTerminalDay } from './reconciliation';
import { settleApprovedTerminalSale, startTerminalReversal } from './settlement-handoff';
import { createCardTerminalService } from './service';
import { createInMemoryTerminalIntentStore } from './store';
import { createScriptedTerminal, TEST_ONLY_ADMISSION } from './testing/scripted-terminal';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
const businessDate = new Date('2026-11-04T00:00:00.000Z');

/** Narrow fake of the money transaction: idempotency, day lock, sale lock, tender insert. */
function fakeSettlementDb(priorRefunds: { amountMinor: number }[] = []) {
  const idempotency = new Map<string, Record<string, unknown>>();
  const tenders: Record<string, unknown>[] = [];
  const db = {
    $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
      const [id, organizationId, deviceId, key, commandType, payloadHash] =
        query.values as string[];
      const k = `${organizationId}:${deviceId}:${key}`;
      if (!idempotency.has(k))
        idempotency.set(k, {
          id,
          organizationId,
          deviceId,
          key,
          commandType,
          payloadHash,
          resultPayload: null,
        });
      return 1;
    }),
    $queryRaw: vi.fn(async () => []),
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn(
        async ({ where }: { where: { organizationId_deviceId_key: Record<string, string> } }) => {
          const w = where.organizationId_deviceId_key;
          return idempotency.get(`${w.organizationId}:${w.deviceId}:${w.key}`) ?? null;
        }
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { resultPayload: unknown } }) => {
          for (const row of idempotency.values())
            if (row.id === where.id) row.resultPayload = data.resultPayload;
          return {};
        }
      ),
    },
    pharmacyDailyClose: { findFirst: vi.fn(async () => null) },
    pharmacySale: {
      findFirst: vi.fn(async () => ({
        id: 'sale-1',
        status: 'OPEN',
        customerId: null,
        // Sale total 1,500; the card pays 1,000, so the sale stays open (no completion path).
        lines: [
          { id: 'line-1', quantity: 1, unitPriceMinor: 1_500, discountMinor: 0, medicine: {} },
        ],
        tenders: [],
      })),
    },
    pharmacyTender: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `tender-${tenders.length + 1}`, createdAt: new Date(), ...data };
        tenders.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = tenders.find((t) =>
          Object.entries(where).every(([key, value]) => t[key] === value)
        );
        return row ? { id: row.id as string } : null;
      }),
    },
    pharmacyRefund: {
      findMany: vi.fn(async () => priorRefunds),
    },
  };
  return { db, tenders };
}

function terminalService(admitted: boolean) {
  const terminal = createScriptedTerminal({
    claimCertified: true,
    sale: ['HANG'],
    status: [
      {
        kind: 'APPROVED',
        providerRef: 'prov-sale-1',
        amountMinor: 1_000,
        approvalCode: 'OK1234',
        last4: '1111',
      },
    ],
    report: [{ providerRef: 'prov-sale-1', kind: 'SALE', amountMinor: 1_000 }],
  });
  const store = createInMemoryTerminalIntentStore();
  let clock = Date.parse('2026-11-04T10:00:00.000Z');
  const service = createCardTerminalService({
    store,
    provider: terminal.provider,
    ...(admitted ? { admission: TEST_ONLY_ADMISSION } : {}),
    environment: 'test',
    now: () => new Date((clock += 1_000)),
    timeoutMs: 20,
    recovery: { maxAttempts: 3, notFoundGraceMs: 60_000 },
  });
  return { terminal, store, service };
}

describe('pharmacy card terminal — mocked end to end (DEV-743)', () => {
  beforeEach(() => vi.clearAllMocks());

  const startInput = {
    saleId: 'sale-1',
    terminalId: 'term-1',
    amountMinor: 1_000,
    currency: 'PKR',
    attemptKey: 'counter-click-1',
  };

  it('timeout → recovery → one tender → replay-safe → reconciled', async () => {
    const { terminal, store, service } = terminalService(true);
    const { db, tenders } = fakeSettlementDb();

    // 1. Counter starts a card payment; the terminal hangs; the outcome is UNKNOWN.
    const pending = await service.startSale(scope, startInput);
    expect(pending.state).toBe('UNKNOWN');
    expect(tenders).toHaveLength(0);

    // 2. The cashier presses Pay again: same attempt, no second charge.
    await service.startSale(scope, startInput);
    expect(terminal.count('startSale')).toBe(1);

    // 3. Recovery asks the provider by intent ref and learns it was approved.
    const approved = await service.recover(scope, pending.intentRef);
    expect(approved).toMatchObject({ state: 'APPROVED', providerRef: 'prov-sale-1' });

    // 4. Settlement records the tender from the stored intent, without charging.
    const settleInput = { intentRef: approved.intentRef, deviceId: 'device-1', businessDate };
    const result = await settleApprovedTerminalSale(db as never, service, scope, settleInput);
    expect(result).toMatchObject({ replayed: false });
    expect(tenders).toEqual([
      expect.objectContaining({
        saleId: 'sale-1',
        type: 'CARD',
        amountMinor: 1_000,
        provider: 'SCRIPTED_TERMINAL',
        providerRef: 'prov-sale-1',
      }),
    ]);
    expect(await service.getIntent(scope, approved.intentRef)).toMatchObject({
      state: 'SETTLED',
      ledgerRef: result.tenderId,
    });
    expect(terminal.count('startSale')).toBe(1);

    // 5. Replays: the helper returns the recorded tender; a raw settlement command from
    //    another device with the same key is refused. Still one tender.
    expect(await settleApprovedTerminalSale(db as never, service, scope, settleInput)).toEqual({
      tenderId: result.tenderId,
      replayed: true,
    });
    await expect(
      applyPharmacyTender(db as never, scope, {
        saleId: 'sale-1',
        deviceId: 'device-2',
        businessDate,
        type: 'CARD',
        amountMinor: 1_000,
        idempotencyKey: tenderIdempotencyKeyFor(approved),
        adapter: service.settlementAdapter(scope, approved.intentRef),
      })
    ).rejects.toEqual(expect.objectContaining({ reason: 'UNCERTIFIED_PROVIDER' }));
    expect(tenders).toHaveLength(1);

    // 6. The day reconciles against the provider report.
    const report = reconcileTerminalDay({
      providerName: 'SCRIPTED_TERMINAL',
      intents: await store.listForSale(scope.organizationId, 'sale-1'),
      ledger: tenders.map((row) => ({
        id: row.id as string,
        kind: 'TENDER' as const,
        provider: row.provider as string,
        providerRef: row.providerRef as string,
        amountMinor: row.amountMinor as number,
      })),
      providerRecords: await terminal.provider.settlementReport!(
        { terminalId: 'term-1', businessDate: '2026-11-04' },
        new AbortController().signal
      ),
    });
    expect(report.balanced).toBe(true);

    // No card data anywhere in what was stored.
    expect(JSON.stringify({ intents: store.all(), tenders })).not.toMatch(/\d{13,19}/);
  });

  it('fails closed in settlement when the provider is not admitted (production today)', async () => {
    // Drive an approved intent with a test-admitted service, then hand it to settlement
    // through a service using the real, empty production admission list.
    const admitted = terminalService(true);
    const intent = await admitted.service.startSale(scope, startInput);
    const approved = await admitted.service.recover(scope, intent.intentRef);
    expect(approved.state).toBe('APPROVED');
    const production = createCardTerminalService({
      store: admitted.store,
      provider: admitted.terminal.provider,
      environment: 'production',
      timeoutMs: 20,
      recovery: { maxAttempts: 3, notFoundGraceMs: 60_000 },
    });
    const { db, tenders } = fakeSettlementDb();
    await expect(
      settleApprovedTerminalSale(db as never, production, scope, {
        intentRef: approved.intentRef,
        deviceId: 'device-1',
        businessDate,
      })
    ).rejects.toEqual(expect.objectContaining({ reason: 'UNCERTIFIED_PROVIDER' }));
    expect(tenders).toHaveLength(0);
    expect(mocks.postTenderEntry).not.toHaveBeenCalled();
    // The approval is still there to settle once a provider is authorized.
    expect(await admitted.service.getIntent(scope, approved.intentRef)).toMatchObject({
      state: 'APPROVED',
    });
    // And the production service cannot start a charge at all.
    await expect(
      production.startSale(scope, { ...startInput, saleId: 'sale-2', attemptKey: 'x' })
    ).rejects.toMatchObject({ reason: 'PROVIDER_NOT_ADMITTED' });
  });

  it('finishes a settlement that committed before the intent was marked settled', async () => {
    const { service } = terminalService(true);
    const intent = await service.startSale(scope, { ...startInput, attemptKey: 'crash' });
    const approved = await service.recover(scope, intent.intentRef);
    const { db, tenders } = fakeSettlementDb();
    // The tender commits, then the process dies before recordSettlement.
    await applyPharmacyTender(db as never, scope, {
      saleId: 'sale-1',
      deviceId: 'device-1',
      businessDate,
      type: 'CARD',
      amountMinor: 1_000,
      idempotencyKey: tenderIdempotencyKeyFor(approved),
      adapter: service.settlementAdapter(scope, approved.intentRef),
    });
    expect(tenders).toHaveLength(1);
    // The same device retries through the helper: settlement replays, nothing is added.
    const retry = await settleApprovedTerminalSale(db as never, service, scope, {
      intentRef: approved.intentRef,
      deviceId: 'device-1',
      businessDate,
    });
    expect(retry).toMatchObject({ tenderId: tenders[0]!.id, replayed: true });
    expect(tenders).toHaveLength(1);
    expect(await service.getIntent(scope, approved.intentRef)).toMatchObject({
      state: 'SETTLED',
      ledgerRef: tenders[0]!.id,
    });
  });

  it('recovers an approval whose hand-off claim was lost before the tender committed', async () => {
    const { service } = terminalService(true);
    const intent = await service.startSale(scope, { ...startInput, attemptKey: 'lost' });
    const approved = await service.recover(scope, intent.intentRef);
    // A settlement claimed the hand-off, then its transaction died: no tender, claim left.
    const lost = service.settlementAdapter(scope, approved.intentRef);
    expect(
      (
        await lost.execute({
          capability: 'SALE',
          amountMinor: 1_000,
          operationRef: tenderIdempotencyKeyFor(approved),
        })
      ).approved
    ).toBe(true);
    const { db, tenders } = fakeSettlementDb();
    // Any device can now finish it: under the sale lock the ledger shows no tender.
    const result = await settleApprovedTerminalSale(db as never, service, scope, {
      intentRef: approved.intentRef,
      deviceId: 'device-2',
      businessDate,
    });
    expect(tenders).toHaveLength(1);
    expect(await service.getIntent(scope, approved.intentRef)).toMatchObject({
      state: 'SETTLED',
      ledgerRef: result.tenderId,
    });
  });

  it('reopens an intent marked settled whose tender never committed', async () => {
    const { service } = terminalService(true);
    const intent = await service.startSale(scope, { ...startInput, attemptKey: 'phantom' });
    const approved = await service.recover(scope, intent.intentRef);
    const rolledBack = fakeSettlementDb();
    await settleApprovedTerminalSale(rolledBack.db as never, service, scope, {
      intentRef: approved.intentRef,
      deviceId: 'device-1',
      businessDate,
    });
    // That transaction never committed: the real ledger is empty.
    const { db, tenders } = fakeSettlementDb();
    const retry = await settleApprovedTerminalSale(db as never, service, scope, {
      intentRef: approved.intentRef,
      deviceId: 'device-1',
      businessDate,
    });
    expect(retry.replayed).toBe(false);
    expect(tenders).toHaveLength(1);
    expect(await service.getIntent(scope, approved.intentRef)).toMatchObject({
      state: 'SETTLED',
      ledgerRef: retry.tenderId,
    });
  });

  it('counts a manual cash refund before refunding the card', async () => {
    const { service, terminal } = terminalService(true);
    const intent = await service.startSale(scope, { ...startInput, attemptKey: 'refund' });
    const approved = await service.recover(scope, intent.intentRef);
    await settleApprovedTerminalSale(fakeSettlementDb().db as never, service, scope, {
      intentRef: approved.intentRef,
      deviceId: 'device-1',
      businessDate,
    });
    // The whole 1,000 was already refunded in cash through settlement's fallback.
    const { db } = fakeSettlementDb([{ amountMinor: 1_000 }]);
    await expect(
      startTerminalReversal(db as never, service, scope, {
        saleIntentRef: approved.intentRef,
        amountMinor: 1_000,
        attemptKey: 'r-1',
        batchOpen: false,
      })
    ).rejects.toMatchObject({ reason: 'REVERSAL_BLOCKED' });
    expect(terminal.count('refundSale')).toBe(0);
  });

  it('refuses a raw hand-off whose amount differs from the approved intent, writing nothing', async () => {
    const { service } = terminalService(true);
    const intent = await service.startSale(scope, { ...startInput, attemptKey: 'k' });
    const approved = await service.recover(scope, intent.intentRef);
    const { db, tenders } = fakeSettlementDb();
    await expect(
      applyPharmacyTender(db as never, scope, {
        saleId: 'sale-1',
        deviceId: 'device-2',
        businessDate,
        type: 'CARD',
        amountMinor: 900,
        idempotencyKey: tenderIdempotencyKeyFor(approved),
        adapter: service.settlementAdapter(scope, approved.intentRef),
      })
    ).rejects.toEqual(expect.objectContaining({ reason: 'UNCERTIFIED_PROVIDER' }));
    expect(tenders).toHaveLength(0);
    // A refused hand-off takes no claim, so the correct settlement still works.
    await settleApprovedTerminalSale(db as never, service, scope, {
      intentRef: approved.intentRef,
      deviceId: 'device-1',
      businessDate,
    });
    expect(tenders).toHaveLength(1);
  });
});
