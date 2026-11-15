/**
 * #708 — the Sindh r.18 cash memo reprints from history with the same buyer and
 * manufacturer, so completion snapshots both into the immutable receipt identity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./finance-postings', () => ({ postSaleLineEntry: vi.fn(async () => undefined) }));
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn(async () => new Map()) }));

import { completePaidPharmacySale } from './sale-completion';

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
