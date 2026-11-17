import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Integrated tip: settlement also posts finance entries and requests counter evidence.
// This suite is about receipt leases, so those collaborators are stubbed here.
vi.mock('./finance-postings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./finance-postings')>()),
  postTenderEntry: vi.fn(),
  postTenderRefundEntry: vi.fn(),
  postSaleLineEntry: vi.fn(),
}));
vi.mock('./counter-evidence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./counter-evidence')>()),
  requestCounterEvidence: vi.fn(),
}));
// #659: the batch re-check has its own PostgreSQL suite (sale-batch-safety.db.test.ts).
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn(async () => new Map()) }));
vi.mock('./regulatory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));
import { applyPharmacyTender as settle } from './settlement';
import { hashDeviceSecret } from '@/lib/retail-terminal/device-secret';
import { signPharmacyCommand, authenticatePharmacyCommand } from './sales';
const deviceSecret = 'pcd_' + 'a'.repeat(43);
const authenticatedRow = [{ deviceSecretHash: hashDeviceSecret(deviceSecret) }];
function applyPharmacyTender(
  db: Parameters<typeof settle>[0],
  scope: Parameters<typeof settle>[1],
  input: Parameters<typeof settle>[2]
) {
  return settle(db, scope, input, {
    deviceSecret,
    signature: signPharmacyCommand(scope, input.deviceId, input.leasedReceipt, deviceSecret),
  });
}
import { validateLeasedReceiptReplay, OFFLINE_REPLAY_MAX_AGE_DAYS } from './sales';
import { signSnapshotEnvelope, SNAPSHOT_SIGNING_KEY_ID } from './offline-snapshots';
import type { OfflineSnapshotEnvelope } from './offline-snapshot-envelope';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
const saleAt = '2026-09-02T10:00:00.000Z';
function leasedReceipt() {
  const envelope: OfflineSnapshotEnvelope = {
    ...scope,
    deviceId: 'device-1',
    kind: 'RULES',
    version: 1,
    payloadHash: 'a'.repeat(64),
    issuedAt: '2026-09-02T09:00:00.000Z',
    expiresAt: '2026-09-02T12:00:00.000Z',
    safetyLease: {
      issuedAt: '2026-09-02T09:00:00.000Z',
      expiresAt: '2026-09-02T11:00:00.000Z',
      recallVersion: 1,
      licenceVersion: 1,
      ruleVersion: 1,
      recalledBatchIds: [],
    },
    signingKeyId: SNAPSHOT_SIGNING_KEY_ID,
  };
  return {
    leaseId: 'lease-1',
    receiptNumber: 41,
    originalSaleAt: saleAt,
    envelope,
    signature: signSnapshotEnvelope(envelope),
  };
}
function fixture() {
  let idempotency: Record<string, unknown> | null = null;
  const tenderCreate = vi.fn().mockResolvedValue({ id: 'tender-1' });
  const saleUpdate = vi.fn().mockResolvedValue({});
  const db = {
    $executeRaw: vi.fn().mockImplementation(async () => {
      idempotency ??= {
        id: 'idem-1',
        commandType: 'tender',
        payloadHash: '',
        resultPayload: null,
      };
      return 1;
    }),
    // Integrated order: command auth, F3 day lock, sale lock, lease consume, then defaults.
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce(authenticatedRow)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ receipt_number: 41 }])
      .mockResolvedValue(authenticatedRow),
    // F3: the business day is open (no daily close row).
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn().mockImplementation(async () => idempotency),
      update: vi.fn().mockImplementation(async ({ data }) => {
        idempotency = { ...idempotency, resultPayload: data.resultPayload };
        return idempotency;
      }),
    },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'sale-1',
        status: 'OPEN',
        lines: [
          {
            id: 'line-1',
            organizationId: 'org-1',
            branchId: 'branch-1',
            medicineId: 'medicine-1',
            presentationId: 'presentation-1',
            quantity: 1,
            canonicalUnits: 1,
            unitPriceMinor: 100,
            discountMinor: 0,
            medicine: { organizationId: 'org-1', productName: 'Issued medicine', strengths: [] },
            presentation: {
              organizationId: 'org-1',
              medicineId: 'medicine-1',
              presentation: 'Tablet',
            },
            allocations: [
              {
                id: 'allocation-1',
                organizationId: 'org-1',
                branchId: 'branch-1',
                inventoryLotId: 'lot-1',
                canonicalUnits: 1,
                lot: {
                  organizationId: 'org-1',
                  branchId: 'branch-1',
                  batch: {
                    organizationId: 'org-1',
                    medicineId: 'medicine-1',
                    batchNumber: 'B1',
                    expiresAt: new Date('2030-01-01'),
                  },
                },
              },
            ],
          },
        ],
        tenders: [],
      }),
      update: saleUpdate,
    },
    pharmacyTender: { create: tenderCreate },
    pharmacySaleEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const input = {
    saleId: 'sale-1',
    deviceId: 'device-1',
    businessDate: new Date('2026-09-02T00:00:00.000Z'),
    type: 'BANK_TRANSFER' as const,
    providerRef: 'BANK-001',
    amountMinor: 100,
    idempotencyKey: 'retry-1',
    leasedReceipt: leasedReceipt(),
  };

  // Capture the canonical hash inserted by the first command in this narrow fake.
  db.$executeRaw.mockImplementation(async (query: { values: unknown[] }) => {
    idempotency ??= {
      id: 'idem-1',
      commandType: 'tender',
      payloadHash: query.values[5],
      resultPayload: null,
    };
    return 1;
  });

  return { db, input, tenderCreate, saleUpdate };
}

beforeEach(() => {
  vi.stubEnv('PLATFORM_ENCRYPTION_KEY', 'test-only-replay-signing-key');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-03T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('leased receipt replay', () => {
  it('accepts the original sale inside its signed window after that window expires', () => {
    expect(() => validateLeasedReceiptReplay(scope, 'device-1', leasedReceipt())).not.toThrow();
  });
  it('rejects a sale at safety-lease expiry even while the snapshot is valid', () => {
    const receipt = leasedReceipt();
    receipt.originalSaleAt = receipt.envelope.safetyLease.expiresAt;
    expect(() => validateLeasedReceiptReplay(scope, 'device-1', receipt)).toThrow(
      'INVALID_SAFETY_LEASE'
    );
  });
  it('accepts exactly seven days and rejects older replays with replay_stale', () => {
    const boundary = Date.parse(saleAt) + OFFLINE_REPLAY_MAX_AGE_DAYS * 86_400_000;
    expect(() =>
      validateLeasedReceiptReplay(scope, 'device-1', leasedReceipt(), boundary)
    ).not.toThrow();
    expect(() =>
      validateLeasedReceiptReplay(scope, 'device-1', leasedReceipt(), boundary + 1)
    ).toThrow('replay_stale');
  });
  it.each(['invalid', '2026-09-04T10:00:00Z'])(
    'rejects malformed/future original sale time %s',
    (originalSaleAt) => {
      expect(() =>
        validateLeasedReceiptReplay(scope, 'device-1', { ...leasedReceipt(), originalSaleAt })
      ).toThrow('INVALID_REPLAY_TIME');
    }
  );
  it('rejects a forged window and another device scope', () => {
    const receipt = leasedReceipt();
    receipt.envelope.safetyLease.expiresAt = '2026-09-02T12:00:00Z';
    expect(() => validateLeasedReceiptReplay(scope, 'device-1', receipt)).toThrow(
      'INVALID_SAFETY_LEASE'
    );
    expect(() => validateLeasedReceiptReplay(scope, 'other-device', leasedReceipt())).toThrow(
      'INVALID_SAFETY_LEASE'
    );
  });
  it('preserves the leased number in sale, immutable event and idempotent retry without online allocation', async () => {
    const { db, input, tenderCreate, saleUpdate } = fixture();
    const first = await applyPharmacyTender(db as never, scope, input);
    const retry = await applyPharmacyTender(db as never, scope, input);
    expect(first).toMatchObject({ receiptNumber: 41, replayed: false });
    expect(retry).toMatchObject({ receiptNumber: 41, replayed: true });
    expect(tenderCreate).toHaveBeenCalledTimes(1);
    expect(saleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ receiptNumber: 41 }) })
    );
    expect(db.pharmacySaleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ payload: expect.objectContaining({ receiptNumber: 41 }) }),
      })
    );
    const sql = db.$queryRaw.mock.calls.map(([query]) => query.sql).join(' ');
    expect(sql).toContain('UPDATE pharmacy_receipt_number_leases');
    expect(sql).not.toContain('INSERT INTO pharmacy_receipt_number_sequences');
  });
  it('rejects a duplicate number under another command before writing a tender', async () => {
    const { db, input, tenderCreate } = fixture();
    db.$queryRaw
      .mockReset()
      .mockResolvedValueOnce(authenticatedRow)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(
      applyPharmacyTender(db as never, scope, { ...input, idempotencyKey: 'another-command' })
    ).rejects.toThrow('INVALID_RECEIPT_LEASE');
    expect(tenderCreate).not.toHaveBeenCalled();
  });
  it('rejects a leased receipt on a partial tender', async () => {
    const { db, input, tenderCreate } = fixture();
    await expect(
      applyPharmacyTender(db as never, scope, { ...input, amountMinor: 50 })
    ).rejects.toThrow('LEASE_REQUIRES_SETTLEMENT');
    expect(tenderCreate).not.toHaveBeenCalled();
  });
});

describe('device command authentication', () => {
  it.each(['originalSaleAt', 'leaseId', 'receiptNumber', 'deviceId', 'branchId'])(
    'rejects tampered %s',
    async (field) => {
      const payload = leasedReceipt();
      const signature = signPharmacyCommand(scope, 'device-1', payload, deviceSecret);
      const changed = { ...payload };
      if (field === 'originalSaleAt') changed.originalSaleAt = '2026-09-02T10:30:00Z';
      if (field === 'leaseId') changed.leaseId = 'other';
      if (field === 'receiptNumber') changed.receiptNumber = 42;
      const db = { $queryRaw: vi.fn().mockResolvedValue(authenticatedRow) };
      await expect(
        authenticatePharmacyCommand(
          db as never,
          field === 'branchId' ? { ...scope, branchId: 'other' } : scope,
          field === 'deviceId' ? 'other' : 'device-1',
          changed,
          { deviceSecret, signature }
        )
      ).rejects.toThrow('INVALID_COMMAND_SIGNATURE');
    }
  );
  it('refuses unsigned replay before any idempotency or tender write', async () => {
    const { db, input, tenderCreate } = fixture();
    await expect(settle(db as never, scope, input)).rejects.toThrow('INVALID_COMMAND_SIGNATURE');
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(tenderCreate).not.toHaveBeenCalled();
  });
  it('refuses rotated or revoked device credentials', async () => {
    const payload = leasedReceipt();
    const authentication = {
      deviceSecret,
      signature: signPharmacyCommand(scope, 'device-1', payload, deviceSecret),
    };
    for (const rows of [[], [{ deviceSecretHash: 'rotated' }]]) {
      await expect(
        authenticatePharmacyCommand(
          { $queryRaw: vi.fn().mockResolvedValue(rows) } as never,
          scope,
          'device-1',
          payload,
          authentication
        )
      ).rejects.toThrow('INVALID_COMMAND_SIGNATURE');
    }
  });
});
