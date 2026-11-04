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
import { createCardTerminalService } from './service';
import { createInMemoryTerminalIntentStore } from './store';
import { createScriptedTerminal, TEST_ONLY_ADMISSION } from './testing/scripted-terminal';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
const businessDate = new Date('2026-11-04T00:00:00.000Z');

/** Narrow fake of the money transaction: idempotency, day lock, sale lock, tender insert. */
function fakeSettlementDb() {
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

  it('timeout → recovery → one tender → replay-safe → reconciled', async () => {
    const { terminal, store, service } = terminalService(true);
    const { db, tenders } = fakeSettlementDb();

    // 1. Counter starts a card payment; the terminal hangs; the outcome is UNKNOWN.
    const pending = await service.startSale(scope, {
      saleId: 'sale-1',
      terminalId: 'term-1',
      amountMinor: 1_000,
      currency: 'PKR',
      attemptKey: 'counter-click-1',
    });
    expect(pending.state).toBe('UNKNOWN');
    expect(tenders).toHaveLength(0);

    // 2. The cashier presses Pay again: same attempt, no second charge.
    await service.startSale(scope, {
      saleId: 'sale-1',
      terminalId: 'term-1',
      amountMinor: 1_000,
      currency: 'PKR',
      attemptKey: 'counter-click-1',
    });
    expect(terminal.count('startSale')).toBe(1);

    // 3. Recovery asks the provider by intent ref and learns it was approved.
    const approved = await service.recover(scope.organizationId, pending.intentRef);
    expect(approved).toMatchObject({ state: 'APPROVED', providerRef: 'prov-sale-1' });

    // 4. Settlement records the tender from the approved outcome, without charging.
    const tenderInput = {
      saleId: 'sale-1',
      deviceId: 'device-1',
      businessDate,
      type: 'CARD' as const,
      amountMinor: 1_000,
      idempotencyKey: tenderIdempotencyKeyFor(approved),
      adapter: service.settlementAdapter(approved),
    };
    const result = (await applyPharmacyTender(db as never, scope, tenderInput)) as {
      tenderId: string;
      replayed: boolean;
    };
    expect(result).toMatchObject({ settled: false, remainingMinor: 500, replayed: false });
    expect(tenders).toEqual([
      expect.objectContaining({
        type: 'CARD',
        amountMinor: 1_000,
        provider: 'SCRIPTED_TERMINAL',
        providerRef: 'prov-sale-1',
      }),
    ]);
    expect(terminal.count('startSale')).toBe(1);

    // 5. A replayed settlement command returns the bound result: still one tender.
    const replay = await applyPharmacyTender(db as never, scope, tenderInput);
    expect(replay).toMatchObject({ tenderId: result.tenderId, replayed: true });
    expect(tenders).toHaveLength(1);

    // 6. The intent records its tender; the day reconciles against the provider report.
    await service.recordSettlement(scope.organizationId, approved.intentRef, result.tenderId);
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

  it('fails closed in settlement when the provider is not admitted (today’s production state)', async () => {
    // Drive an approved intent with a test-admitted service, then hand it to settlement
    // through a service using the real, empty production admission list.
    const admitted = terminalService(true);
    const intent = await admitted.service.startSale(scope, {
      saleId: 'sale-1',
      terminalId: 'term-1',
      amountMinor: 1_000,
      currency: 'PKR',
      attemptKey: 'counter-click-1',
    });
    const approved = await admitted.service.recover(scope.organizationId, intent.intentRef);
    const production = createCardTerminalService({
      store: admitted.store,
      provider: admitted.terminal.provider,
      environment: 'production',
      timeoutMs: 20,
      recovery: { maxAttempts: 3, notFoundGraceMs: 60_000 },
    });
    const { db, tenders } = fakeSettlementDb();
    await expect(
      applyPharmacyTender(db as never, scope, {
        saleId: 'sale-1',
        deviceId: 'device-1',
        businessDate,
        type: 'CARD',
        amountMinor: 1_000,
        idempotencyKey: tenderIdempotencyKeyFor(approved),
        adapter: production.settlementAdapter(approved),
      })
    ).rejects.toEqual(expect.objectContaining({ reason: 'UNCERTIFIED_PROVIDER' }));
    expect(tenders).toHaveLength(0);
    expect(mocks.postTenderEntry).not.toHaveBeenCalled();
    // And the production service cannot start a charge at all.
    await expect(
      production.startSale(scope, {
        saleId: 'sale-2',
        terminalId: 'term-1',
        amountMinor: 1_000,
        currency: 'PKR',
        attemptKey: 'x',
      })
    ).rejects.toMatchObject({ reason: 'PROVIDER_NOT_ADMITTED' });
  });

  it('refuses a hand-off whose amount differs from the approved intent, writing nothing', async () => {
    const { service } = terminalService(true);
    const intent = await service.startSale(scope, {
      saleId: 'sale-1',
      terminalId: 'term-1',
      amountMinor: 1_000,
      currency: 'PKR',
      attemptKey: 'k',
    });
    const approved = await service.recover(scope.organizationId, intent.intentRef);
    const { db, tenders } = fakeSettlementDb();
    await expect(
      applyPharmacyTender(db as never, scope, {
        saleId: 'sale-1',
        deviceId: 'device-1',
        businessDate,
        type: 'CARD',
        amountMinor: 900,
        idempotencyKey: tenderIdempotencyKeyFor(approved),
        adapter: service.settlementAdapter(approved),
      })
    ).rejects.toEqual(expect.objectContaining({ reason: 'UNCERTIFIED_PROVIDER' }));
    expect(tenders).toHaveLength(0);
  });
});
