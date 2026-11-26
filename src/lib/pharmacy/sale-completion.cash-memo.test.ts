/**
 * #708 — the Sindh r.18 cash memo reprints from history with the same buyer and
 * manufacturer, so completion snapshots both into the immutable receipt identity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// These tests cover the cash memo as it will behave once counsel lifts the #708 hold.
// The hold itself, with the real constant, is proven in sindh-cash-memo-hold.test.ts.
vi.mock('./sindh-cash-memo-hold', () => ({ SINDH_CASH_MEMO_LIVE: true }));
vi.mock('server-only', () => ({}));
vi.mock('./finance-postings', () => ({ postSaleLineEntry: vi.fn(async () => undefined) }));
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn(async () => new Map()) }));

import { completePaidPharmacySale } from './sale-completion';
import { receiptTextSchema } from '@/lib/receipts/configuration';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'cashier_1' };
const businessDate = new Date('2026-11-14T00:00:00.000Z');

function sale(options: {
  customer?: { displayName: string } | null;
  manufacturer?: string | null;
}) {
  return {
    id: 'sale_1',
    status: 'OPEN',
    receiptNumber: null,
    receiptDeviceId: null,
    businessDate: null,
    completedAt: null,
    customer: options.customer ?? null,
    tenders: [],
    lines: [
      {
        id: 'line_1',
        organizationId: 'org_a',
        branchId: 'branch_a',
        medicineId: 'med_1',
        presentationId: 'pres_1',
        canonicalUnits: 10,
        prescriptionLineId: null,
        medicine: {
          organizationId: 'org_a',
          productName: 'Paracetamol',
          manufacturer: options.manufacturer ?? null,
          strengths: [{ value: '500', unit: 'mg' }],
        },
        presentation: { organizationId: 'org_a', medicineId: 'med_1', presentation: 'Tablet' },
        allocations: [
          {
            id: 'al_1',
            organizationId: 'org_a',
            branchId: 'branch_a',
            inventoryLotId: 'lot_1',
            canonicalUnits: 10,
            lot: {
              organizationId: 'org_a',
              branchId: 'branch_a',
              batch: {
                organizationId: 'org_a',
                medicineId: 'med_1',
                batchNumber: 'B-001',
                expiresAt: new Date('2027-06-30T00:00:00.000Z'),
              },
            },
          },
        ],
      },
    ],
  };
}

let db: ReturnType<typeof makeDb>;
function makeDb() {
  return {
    organization: { findUnique: vi.fn(async () => ({ timezone: 'Asia/Karachi' })) },
    branchRegulatoryProfile: {
      findFirst: vi.fn(async () => ({
        provinceCode: 'PK-SD',
        licenceNumber: 'SYNTHETIC-SD-77',
        licenceValidFrom: new Date('2026-01-01T00:00:00Z'),
        licenceValidTo: new Date('2027-12-31T00:00:00Z'),
        qualifiedPersonRegistration: 'SYNTHETIC-PCP-1',
      })),
    },
    $queryRaw: vi.fn(async () => [{ receipt_number: 7 }]),
    pharmacySale: { update: vi.fn(async () => ({})) },
    pharmacySaleEvent: {
      create: vi.fn<(args: { data: { payload: Record<string, unknown> } }) => Promise<object>>(
        async () => ({})
      ),
    },
  };
}

async function snapshotFor(
  s: ReturnType<typeof sale>,
  buyerName?: string
): Promise<Record<string, unknown> & { lines: Record<string, unknown>[] }> {
  await completePaidPharmacySale(db as never, scope, s as never, {
    deviceId: 'counter-a',
    businessDate,
    ...(buyerName !== undefined ? { buyerName } : {}),
  });
  return db.pharmacySaleEvent.create.mock.calls[0]![0].data.payload as never;
}

beforeEach(() => {
  db = makeDb();
});

describe('#708 cash memo facts in the completion snapshot', () => {
  it('freezes the effective Sindh licence and pharmacist facts at issuance with tenant scope', async () => {
    const snapshot = await snapshotFor(sale({}));
    expect(snapshot.cashMemoIdentity).toMatchObject({
      provinceCode: 'PK-SD',
      licenceNumber: 'SYNTHETIC-SD-77',
      licenceValidFrom: '2026-01-01T00:00:00.000Z',
      licenceValidTo: '2027-12-31T00:00:00.000Z',
      pharmacistRegistration: 'SYNTHETIC-PCP-1',
    });
    expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org_a', branchId: 'branch_a' }),
      })
    );
    expect(db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org_a' },
      select: { timezone: true, legalName: true },
    });
  });

  it('records a non-Sindh decision so moving the branch cannot turn an issued Punjab receipt into a cash memo', async () => {
    const profile = await db.branchRegulatoryProfile.findFirst();
    db.branchRegulatoryProfile.findFirst.mockResolvedValue({ ...profile, provinceCode: 'PK-PB' });
    expect((await snapshotFor(sale({}))).cashMemoIdentity).toBeNull();
  });

  it('preserves the full buyer and manufacturer lengths accepted by the existing patient and medicine forms', async () => {
    const buyer = 'B'.repeat(200);
    const manufacturer = 'M'.repeat(300);
    const snapshot = await snapshotFor(sale({ manufacturer }), buyer);
    expect(snapshot.buyerName).toBe(buyer);
    expect(snapshot.lines[0]!.manufacturer).toBe(manufacturer);
  });

  it('records the buyer typed at tender ahead of the sale customer', async () => {
    const snapshot = await snapshotFor(
      sale({ customer: { displayName: 'Customer On File' } }),
      '  Ayesha Khan  '
    );
    expect(snapshot.buyerName).toBe('Ayesha Khan');
  });

  it("falls back to the sale's customer when no buyer is typed", async () => {
    const snapshot = await snapshotFor(sale({ customer: { displayName: 'Bilal Ahmed' } }));
    expect(snapshot.buyerName).toBe('Bilal Ahmed');
  });

  it('leaves an unnamed walk-in without a buyer rather than an empty string', async () => {
    const snapshot = await snapshotFor(sale({ customer: null }), '   ');
    expect(snapshot).not.toHaveProperty('buyerName');
  });

  it('drops characters a receipt cannot print from a stored customer or manufacturer', async () => {
    const snapshot = await snapshotFor(
      sale({
        customer: { displayName: '\tBilal‮Ahmed\u0000' },
        manufacturer: 'GSK⁦ Pakistan\n',
      })
    );
    expect(snapshot.buyerName).toBe('Bilal Ahmed');
    expect(snapshot.lines[0]!.manufacturer).toBe('GSK Pakistan');
    for (const value of [snapshot.buyerName, snapshot.lines[0]!.manufacturer])
      expect(receiptTextSchema(2000).safeParse(value).success).toBe(true);
  });

  it('never leaves half of a character at the length limit', async () => {
    const snapshot = await snapshotFor(sale({ customer: { displayName: `${'B'.repeat(199)}😀` } }));
    expect(snapshot.buyerName).toBe('B'.repeat(199));
  });

  it('snapshots the manufacturer on every line, and omits a blank one', async () => {
    const named = await snapshotFor(sale({ manufacturer: ' GSK Pakistan ' }));
    expect(named.lines[0]).toMatchObject({
      medicineName: 'Paracetamol',
      manufacturer: 'GSK Pakistan',
    });

    db = makeDb();
    const blank = await snapshotFor(sale({ manufacturer: '  ' }));
    expect(blank.lines[0]).not.toHaveProperty('manufacturer');
  });
});

it('records the seller, branch and issuing counter on the immutable receipt snapshot', async () => {
  const issuedSale = { ...sale({}), visibilityAnchor: { name: 'Issued branch' } };
  Object.assign(db, {
    pharmacyRegisteredDevice: { findFirst: vi.fn(async () => ({ name: 'Issued counter' })) },
  });
  db.organization.findUnique.mockResolvedValue({
    ...{ legalName: 'Issued seller' },
    timezone: 'Asia/Karachi',
  });
  const snapshot = await snapshotFor(issuedSale);
  expect(snapshot.seller).toEqual({
    branchName: 'Issued branch',
    registeredName: 'Issued seller',
    counterLabel: 'Issued counter',
  });
});
