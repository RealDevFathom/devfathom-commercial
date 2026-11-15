import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { CounterReceipt } from './counter-receipt';
import { readDispensingLabelSources } from './dispensing-label-source';

const scope = { organizationId: 'org', branchId: 'branch' };
const actorScope = { ...scope, actorId: 'operator' };
const receipt = {
  saleId: 'sale',
  receiptNumber: 1,
  completedAt: '2026-09-29T10:00:00Z',
  lines: [{ saleLineId: 'line', identityStatus: 'ISSUED' }],
} as CounterReceipt;
function fixture() {
  const capture = {
    directionsEnglish: 'Take one tablet daily.',
    directionsUrdu: 'روزانہ ایک گولی لیں۔',
    fill: { prescriptionLineId: 'rx-line' },
    pharmacistDecision: { actorUserId: 'signer', reviewItem: { prescriptionLineId: 'rx-line' } },
  };
  const db = {
    branchRegulatoryProfile: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ licenceNumber: 'LIC', qualifiedPersonRegistration: 'REG' }),
    },
    pharmacySaleLine: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'line', medicineId: 'med', presentationId: 'tablet' }]),
    },
    pharmacyRefillReminderCapture: { findMany: vi.fn().mockResolvedValue([capture]) },
    user: { findFirst: vi.fn().mockResolvedValue({ name: 'Decision Actor' }) },
  };
  return {
    db,
    capture,
    read: () => readDispensingLabelSources(db as unknown as ScopedDb, actorScope, receipt),
  };
}
describe('label source provenance', () => {
  it('uses scoped Rx sale, capture, fill/review and decision actor with minimal output', async () => {
    const { db, read } = fixture();
    expect(await read()).toEqual([
      {
        saleId: 'sale',
        saleLineId: 'line',
        rx: true,
        licenceNumber: 'LIC',
        pharmacistRegistration: 'REG',
        pharmacistName: 'Decision Actor',
        directionsEnglish: 'Take one tablet daily.',
        directionsUrdu: 'روزانہ ایک گولی لیں۔',
      },
    ]);
    expect(db.pharmacySaleLine.findMany).toHaveBeenCalledWith({
      where: {
        ...scope,
        saleId: 'sale',
        sale: { status: 'COMPLETED' },
        medicine: { rx: true },
        id: { in: ['line'] },
      },
      select: { id: true, medicineId: true, presentationId: true },
    });
    expect(db.pharmacyRefillReminderCapture.findMany.mock.calls[0]![0].where).toEqual({
      ...scope,
      pharmacistDecision: {
        organizationId: 'org',
        kind: 'SIGN',
        signedAt: { not: null },
        reviewItem: {
          organizationId: 'org',
          saleLineId: 'line',
          line: { medicineId: 'med', presentationId: 'tablet' },
        },
      },
    });
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org', id: 'signer' },
      select: { name: true },
    });
    expect(db.branchRegulatoryProfile.findFirst.mock.calls[0]![0].where).toMatchObject(scope);
  });
  it('omits missing actor name, retains registration and distinct licence', async () => {
    const { db, read } = fixture();
    db.user.findFirst.mockResolvedValue(null);
    expect((await read())[0]).toMatchObject({
      licenceNumber: 'LIC',
      pharmacistRegistration: 'REG',
    });
    expect((await read())[0]).not.toHaveProperty('pharmacistName');
  });
  it.each(['directionsEnglish', 'directionsUrdu'] as const)(
    'fails closed for missing %s',
    async (field) => {
      const { capture, read } = fixture();
      capture[field] = ' ';
      expect(await read()).toEqual([]);
    }
  );
  it('rejects mismatched fill, missing and ambiguous capture', async () => {
    const { capture, db, read } = fixture();
    capture.fill.prescriptionLineId = 'wrong';
    expect(await read()).toEqual([]);
    db.pharmacyRefillReminderCapture.findMany.mockResolvedValue([]);
    expect(await read()).toEqual([]);
    db.pharmacyRefillReminderCapture.findMany.mockResolvedValue([capture, capture]);
    expect(await read()).toEqual([]);
  });
  it.each(['tenant', 'branch', 'line', 'OTC'])(
    'does not emit source when scoped query excludes wrong %s',
    async () => {
      const { db, read } = fixture();
      db.pharmacySaleLine.findMany.mockResolvedValue([]);
      expect(await read()).toEqual([]);
      expect(db.pharmacyRefillReminderCapture.findMany).not.toHaveBeenCalled();
    }
  );
  it('does not query clinical sources for unsettled receipt', async () => {
    const { db } = fixture();
    expect(
      await readDispensingLabelSources(db as unknown as ScopedDb, scope, {
        ...receipt,
        receiptNumber: null,
      })
    ).toEqual([]);
    expect(db.pharmacySaleLine.findMany).not.toHaveBeenCalled();
  });
});

describe('label licence on a profile start day (DEV-298)', () => {
  const dayStart = new Date('2026-10-21T00:00:00.000Z');
  it.each([
    ['00:30 PKT on the start day', '2026-10-20T19:30:00.000Z', dayStart],
    ['23:59 PKT the day before', '2026-10-20T18:59:00.000Z', new Date('2026-10-20T18:59:00.000Z')],
  ])(
    'selects the version in force on the workspace day at %s',
    async (_label, completedAt, asOf) => {
      const { db } = fixture();
      await readDispensingLabelSources(
        db as unknown as ScopedDb,
        actorScope,
        { ...receipt, completedAt } as CounterReceipt,
        'Asia/Karachi'
      );
      expect(db.branchRegulatoryProfile.findFirst.mock.calls[0]![0].where).toEqual({
        ...scope,
        effectiveFrom: { lte: asOf },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
      });
    }
  );
});
