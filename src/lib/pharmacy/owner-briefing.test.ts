import { describe, expect, it, vi } from 'vitest';

import {
  assertWhatsAppBriefingSafe,
  buildOwnerBriefing,
  DEFAULT_OWNER_BRIEFING_CONFIG,
  isWeeklyBriefingDay,
  ownerBriefingConfig,
  ownerBriefingWindow,
  readOwnerBriefingDemand,
  renderOwnerBriefingApp,
  renderOwnerBriefingWhatsApp,
} from './owner-briefing';

type DemandRow = {
  createdAt: Date;
  requestedMedicineId: string | null;
  requestedText: string | null;
  estimatedValueMinor: number | null;
  status: 'OPEN' | 'RECOVERED' | 'CLOSED';
  recoveredAt: Date | null;
  recoveredSaleLineId: string | null;
};

const within = (at: Date, range: { gte: Date; lt: Date }) => at >= range.gte && at < range.lt;

/** A tiny seeded tenant: demand events, sale lines, catalogue and purchasing rows. */
function seededDb(seed: {
  events: DemandRow[];
  saleLines: Array<{ id: string; grossMinor: number; discountMinor: number }>;
  medicines: Array<{ id: string; productName: string; brandName: string | null }>;
  purchaseOrderLines?: Array<{ medicineId: string; status: string; createdAt: Date }>;
  requisitionLines?: Array<{ medicineId: string; status: string; createdAt: Date }>;
}) {
  const findMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    if ('createdAt' in where) {
      return seed.events.filter((event) =>
        within(event.createdAt, where.createdAt as { gte: Date; lt: Date })
      );
    }
    return seed.events.filter(
      (event) =>
        event.status === 'RECOVERED' &&
        event.recoveredSaleLineId &&
        event.recoveredAt &&
        within(event.recoveredAt, where.recoveredAt as { gte: Date; lt: Date })
    );
  });
  const purchaseFilter =
    (
      rows: Array<{ medicineId: string; status: string; createdAt: Date }> | undefined,
      rel: string
    ) =>
    async ({ where }: { where: Record<string, unknown> }) => {
      const relation = where[rel] as { createdAt: { gte: Date } };
      const match = (rows ?? [])
        .filter(
          (row) =>
            row.medicineId === where.medicineId &&
            row.status !== 'CANCELLED' &&
            row.createdAt >= relation.createdAt.gte
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return match ? { [rel]: { status: match.status } } : null;
    };
  return {
    unfulfilledDemandEvent: { findMany },
    pharmacySaleLine: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        seed.saleLines.filter((line) => where.id.in.includes(line.id))
      ),
    },
    medicine: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          seed.medicines.find((medicine) => medicine.id === where.id) ?? null
      ),
    },
    pharmacyPurchaseOrderLine: {
      findFirst: vi.fn(purchaseFilter(seed.purchaseOrderLines, 'purchaseOrder')),
    },
    pharmacyRequisitionLine: {
      findFirst: vi.fn(purchaseFilter(seed.requisitionLines, 'requisition')),
    },
  };
}

const scope = { organizationId: 'org_1', branchId: 'branch_1' };
const ledger = {
  salesMinor: 1_850_000,
  cashMinor: 1_200_000,
  expiryValueMinor30: 90_000,
  expiryValueMinor60: 150_000,
  expiryValueMinor90: 200_000,
  expiryValueMinor180: 400_000,
  khataAgingMinor: 75_000,
};

function event(day: string, partial: Partial<DemandRow>): DemandRow {
  return {
    createdAt: new Date(`${day}T10:00:00.000Z`),
    requestedMedicineId: null,
    requestedText: null,
    estimatedValueMinor: null,
    status: 'OPEN',
    recoveredAt: null,
    recoveredSaleLineId: null,
    ...partial,
  };
}

const seed = {
  medicines: [
    { id: 'med_amox', productName: 'Amoxicillin 500mg Capsule', brandName: 'Amoxil' },
    { id: 'med_para', productName: 'Paracetamol 500mg Tablet', brandName: 'Panadol' },
  ],
  saleLines: [
    { id: 'line_1', grossMinor: 60_000, discountMinor: 5_000 },
    { id: 'line_2', grossMinor: 40_000, discountMinor: 0 },
  ],
  events: [
    event('2026-09-04', { requestedMedicineId: 'med_amox', estimatedValueMinor: 120_000 }),
    event('2026-09-04', { requestedMedicineId: 'med_amox', estimatedValueMinor: 80_000 }),
    event('2026-09-04', { requestedMedicineId: 'med_para', estimatedValueMinor: 30_000 }),
    event('2026-09-04', { requestedText: 'Insulin pen', estimatedValueMinor: null }),
    // Earlier in the week: only the weekly window sees these.
    event('2026-08-30', { requestedMedicineId: 'med_para', estimatedValueMinor: 250_000 }),
    event('2026-08-29', { requestedMedicineId: 'med_para', estimatedValueMinor: 100_000 }),
    // Outside both windows.
    event('2026-08-28', { requestedMedicineId: 'med_para', estimatedValueMinor: 999_999 }),
    event('2026-09-02', {
      requestedMedicineId: 'med_para',
      status: 'RECOVERED',
      recoveredAt: new Date('2026-09-04T12:00:00.000Z'),
      recoveredSaleLineId: 'line_1',
    }),
    event('2026-08-25', {
      requestedMedicineId: 'med_amox',
      status: 'RECOVERED',
      recoveredAt: new Date('2026-09-01T12:00:00.000Z'),
      recoveredSaleLineId: 'line_2',
    }),
  ],
  purchaseOrderLines: [
    { medicineId: 'med_amox', status: 'DRAFT', createdAt: new Date('2026-09-04T13:00:00.000Z') },
    {
      medicineId: 'med_para',
      status: 'CANCELLED',
      createdAt: new Date('2026-09-03T13:00:00.000Z'),
    },
  ],
  requisitionLines: [
    {
      medicineId: 'med_para',
      status: 'SUBMITTED',
      createdAt: new Date('2026-08-31T13:00:00.000Z'),
    },
  ],
};

describe('DEV-78 owner briefing', () => {
  it('reads one day of lost demand, the top gap with its draft PO and recovered sales', async () => {
    const db = seededDb(seed);
    const window = ownerBriefingWindow('2026-09-04', 'DAILY');
    const demand = await readOwnerBriefingDemand(db as never, scope, window);

    // Two Amoxil, one Panadol and one unvalued text request on 2026-09-04 only.
    expect(demand).toMatchObject({
      lostDemandMinor: 230_000,
      walkOuts: 4,
      unvaluedWalkOuts: 1,
      recoveredMinor: 55_000,
      recoveredCount: 1,
      topGap: {
        displayName: 'Amoxil',
        lostMinor: 200_000,
        walkOuts: 2,
        purchaseStatus: 'PO_DRAFT',
      },
    });
    expect(db.unfulfilledDemandEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_1',
          branchId: 'branch_1',
          createdAt: {
            gte: new Date('2026-09-04T00:00:00.000Z'),
            lt: new Date('2026-09-05T00:00:00.000Z'),
          },
        }),
      })
    );

    const briefing = buildOwnerBriefing(window, ledger, demand);
    const app = renderOwnerBriefingApp(briefing);
    expect(app.split('\n')).toEqual([
      'Daily briefing 2026-09-04',
      'Sales PKR 18,500 · Cash PKR 12,000',
      'Lost demand PKR 2,300 (estimate) · 4 walk-outs, 1 without estimate',
      'Top gap: Amoxil · PKR 2,000 lost, 2 walk-outs · draft PO',
      'Recovered PKR 550 from 1 follow-ups',
      'Expiry at risk (30 days) PKR 900 · Khata due PKR 750',
    ]);

    const whatsapp = renderOwnerBriefingWhatsApp(briefing);
    expect(whatsapp).toContain(
      'Top gap: PKR 2,000 lost, 2 walk-outs · draft PO (details in the app)'
    );
    for (const name of ['Amoxil', 'Amoxicillin', 'Capsule', 'Panadol', 'Paracetamol', 'Insulin'])
      expect(whatsapp.toLowerCase()).not.toContain(name.toLowerCase());
    expect(whatsapp).not.toMatch(/\b(drug|medicine|salt|tablet|antibiotic)s?\b/i);
  });

  it('aggregates the weekly summary across seven days ending on the business date', async () => {
    const db = seededDb(seed);
    const window = ownerBriefingWindow('2026-09-04', 'WEEKLY');
    expect(window).toMatchObject({ days: 7, from: '2026-08-29', to: '2026-09-04' });
    const demand = await readOwnerBriefingDemand(db as never, scope, window);

    expect(demand).toMatchObject({
      lostDemandMinor: 580_000,
      walkOuts: 7,
      recoveredMinor: 95_000,
      recoveredCount: 2,
      topGap: {
        displayName: 'Panadol',
        lostMinor: 380_000,
        walkOuts: 4,
        // The cancelled PO is ignored; the submitted requisition is reported.
        purchaseStatus: 'REQUISITION_SUBMITTED',
      },
    });
    const whatsapp = renderOwnerBriefingWhatsApp(buildOwnerBriefing(window, ledger, demand));
    expect(whatsapp.split('\n')[0]).toBe('Weekly summary 2026-08-29 to 2026-09-04');
    expect(whatsapp).not.toMatch(/panadol|paracetamol/i);
  });

  it('reports an unmatched free-text gap without inventing a purchase status', async () => {
    const db = seededDb({
      ...seed,
      events: [event('2026-09-04', { requestedText: 'Insulin pen', estimatedValueMinor: 5_000 })],
    });
    const window = ownerBriefingWindow('2026-09-04', 'DAILY');
    const demand = await readOwnerBriefingDemand(db as never, scope, window);
    expect(demand.topGap).toMatchObject({
      displayName: 'Insulin pen',
      purchaseStatus: 'UNMATCHED',
    });
    expect(db.pharmacyPurchaseOrderLine.findFirst).not.toHaveBeenCalled();
    const whatsapp = renderOwnerBriefingWhatsApp(buildOwnerBriefing(window, ledger, demand));
    expect(whatsapp).not.toMatch(/insulin/i);
  });

  it('renders an empty day truthfully', async () => {
    const db = seededDb({ ...seed, events: [] });
    const window = ownerBriefingWindow('2026-09-04', 'DAILY');
    const demand = await readOwnerBriefingDemand(db as never, scope, window);
    const text = renderOwnerBriefingWhatsApp(
      buildOwnerBriefing(window, { ...ledger, khataAgingMinor: null }, demand)
    );
    expect(text).toContain('Lost demand PKR 0 (estimate) · 0 walk-outs');
    expect(text).toContain('Top gap: none recorded');
    expect(text).toContain('Khata due not available');
  });

  it('rejects WhatsApp text that names an item, salt or category', () => {
    expect(() => assertWhatsAppBriefingSafe('Top gap: Panadol', ['Panadol'])).toThrow();
    expect(() => assertWhatsAppBriefingSafe('Antibiotics short today', [])).toThrow();
    expect(() => assertWhatsAppBriefingSafe('Sales PKR 100', ['Panadol'])).not.toThrow();
  });

  it('takes window, weekday, expiry horizon and look-back from configuration', () => {
    expect(ownerBriefingConfig({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_OWNER_BRIEFING_CONFIG);
    const config = ownerBriefingConfig({
      PHARMACY_OWNER_BRIEFING_WEEKLY_WEEKDAY: '5',
      PHARMACY_OWNER_BRIEFING_EXPIRY_DAYS: '90',
      PHARMACY_OWNER_BRIEFING_PURCHASE_LOOKBACK_DAYS: '14',
    } as unknown as NodeJS.ProcessEnv);
    expect(config).toEqual({
      weeklyDays: 7,
      weeklyWeekday: 5,
      expiryHorizonDays: 90,
      purchaseLookbackDays: 14,
    });
    // Unsupported horizons fall back rather than reading a bucket that does not exist.
    expect(
      ownerBriefingConfig({
        PHARMACY_OWNER_BRIEFING_EXPIRY_DAYS: '45',
      } as unknown as NodeJS.ProcessEnv).expiryHorizonDays
    ).toBe(30);
    expect(isWeeklyBriefingDay('2026-09-04', config)).toBe(true);
    expect(isWeeklyBriefingDay('2026-09-04')).toBe(false);
    const briefing = buildOwnerBriefing(
      ownerBriefingWindow('2026-09-04', 'DAILY', config),
      ledger,
      {
        lostDemandMinor: 0,
        walkOuts: 0,
        unvaluedWalkOuts: 0,
        recoveredMinor: 0,
        recoveredCount: 0,
        topGap: null,
      },
      config
    );
    expect(renderOwnerBriefingApp(briefing)).toContain('Expiry at risk (90 days) PKR 2,000');
  });
});
