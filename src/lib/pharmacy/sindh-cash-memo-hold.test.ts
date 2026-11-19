/**
 * #708 hold — the Sindh cash memo stays off until counsel confirms the walk-in
 * buyer, line items and signature wording under Drugs Rules r.18.
 *
 * These tests use the real hard-coded constant. A Sindh regulatory profile must
 * not activate the memo through sale completion (the automatic province
 * selection), the receipt read, or any print path. Each one fails if
 * `SINDH_CASH_MEMO_LIVE` is flipped to true.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./finance-postings', () => ({ postSaleLineEntry: vi.fn(async () => undefined) }));
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn(async () => new Map()) }));

import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';

import { readCounterReceipt } from './counter';
import { buildCounterBrowserReceipt } from './counter-browser-print';
import {
  counterReceiptCashMemo,
  sindhCashMemoSelected,
  type CounterReceipt,
  type PharmacyReceiptTaxIdentity,
} from './counter-receipt';
import { buildCounterReceiptPreview } from './counter-receipt-presentation';
import { buildPharmacyReceiptPrintDocument } from './receipt-print';
import { completePaidPharmacySale } from './sale-completion';
import { SINDH_CASH_MEMO_LIVE } from './sindh-cash-memo-hold';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'cashier_1' };
const businessDate = new Date('2026-11-14T00:00:00.000Z');
const SINDH_SPELLINGS = ['PK-SD', 'SD', ' pk-sd ', 'Sindh'];

/** Text only a cash memo prints, in English and Urdu. */
const MEMO_TEXT =
  /cash memo|کیش میمو|Manufacturer|تیار کنندہ|Buyer|خریدار|Signature|دستخط|Pharmacist registration|فارماسسٹ رجسٹریشن|Synthetic Buyer|GSK Pakistan|PCP-SYN-1|________________/i;

function sindhProfile(provinceCode: string) {
  return {
    provinceCode,
    premises: { addressLine: '7 Synthetic Street', city: 'Karachi', phone: '021-0000000' },
    licenceNumber: 'SYN-SD-77',
    ntn: 'NTN-SYN',
    strn: null,
    licenceValidFrom: new Date('2026-01-01T00:00:00Z'),
    licenceValidTo: new Date('2027-12-31T00:00:00Z'),
    qualifiedPersonRegistration: 'PCP-SYN-1',
  };
}

function completionDb(provinceCode: string) {
  return {
    organization: { findUnique: vi.fn(async () => ({ timezone: 'Asia/Karachi' })) },
    branchRegulatoryProfile: { findFirst: vi.fn(async () => sindhProfile(provinceCode)) },
    $queryRaw: vi.fn(async () => [{ receipt_number: 7 }]),
    pharmacySale: { update: vi.fn(async () => ({})) },
    pharmacySaleEvent: {
      create: vi.fn<(args: { data: { payload: Record<string, unknown> } }) => Promise<object>>(
        async () => ({})
      ),
    },
  };
}

function openSale() {
  return {
    id: 'sale_1',
    status: 'OPEN',
    receiptNumber: null,
    receiptDeviceId: null,
    businessDate: null,
    completedAt: null,
    customer: { displayName: 'Synthetic Customer' },
    tenders: [],
    lines: [
      {
        id: 'line_1',
        organizationId: 'org_a',
        branchId: 'branch_a',
        medicineId: 'med_1',
        presentationId: 'pres_1',
        canonicalUnits: 2,
        prescriptionLineId: null,
        medicine: {
          organizationId: 'org_a',
          productName: 'Paracetamol',
          manufacturer: 'GSK Pakistan',
          strengths: [{ value: '500', unit: 'mg' }],
        },
        presentation: { organizationId: 'org_a', medicineId: 'med_1', presentation: 'Tablet' },
        allocations: [
          {
            id: 'al_1',
            organizationId: 'org_a',
            branchId: 'branch_a',
            inventoryLotId: 'lot_1',
            canonicalUnits: 2,
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

/** Completes a sale at a branch whose in-force profile names `provinceCode`. */
async function completeAt(provinceCode: string) {
  const db = completionDb(provinceCode);
  await completePaidPharmacySale(db as never, scope, openSale() as never, {
    deviceId: 'counter-a',
    businessDate,
    buyerName: 'Synthetic Buyer',
  });
  return { db, payload: db.pharmacySaleEvent.create.mock.calls[0]![0].data.payload };
}

/** Reads a completed sale back as sale history does, from its identity snapshot. */
async function readBack(payload: Record<string, unknown>): Promise<CounterReceipt> {
  const sale = {
    id: 'sale_1',
    receiptNumber: payload.receiptNumber,
    receiptDeviceId: 'counter-a',
    completedAt: new Date(payload.issuedAt as string),
    businessDate,
    lines: [
      {
        id: 'line_1',
        medicineId: 'med_1',
        presentationId: 'pres_1',
        saleUnit: 'UNIT',
        quantity: 2,
        canonicalUnits: 2,
        unitPriceMinor: 100,
        discountMinor: 0,
        grossMinor: 200,
        allocations: [{ id: 'al_1', inventoryLotId: 'lot_1', canonicalUnits: 2, grossMinor: 200 }],
      },
    ],
    tenders: [],
  };
  const db = {
    pharmacySale: { findFirst: vi.fn(async () => sale) },
    pharmacySaleEvent: { findMany: vi.fn(async () => [{ payload, actorId: null }]) },
    pharmacyRegisteredDevice: { findFirst: vi.fn(async () => null) },
    user: { findFirst: vi.fn() },
  };
  return readCounterReceipt(
    db as never,
    { organizationId: 'org_a', branchId: 'branch_a' },
    'sale_1',
    { name: 'Synthetic pharmacy', currency: 'PKR' }
  );
}

const sindhIdentity: PharmacyReceiptTaxIdentity = {
  address: '7 Synthetic Street, Karachi',
  phone: '021-0000000',
  licenceNumber: 'SYN-SD-77',
  ntn: 'NTN-SYN',
  strn: null,
  provinceCode: 'PK-SD',
  licenceValidFrom: '2026-01-01T00:00:00.000Z',
  licenceValidTo: '2027-12-31T00:00:00.000Z',
  pharmacistRegistration: 'PCP-SYN-1',
};

/** Every print path a receipt reaches, for a receipt read under a Sindh profile. */
function everyPrint(receipt: CounterReceipt, taxIdentity: PharmacyReceiptTaxIdentity) {
  const withIdentity = { ...receipt, taxIdentity };
  const escPos = buildPharmacyReceiptPrintDocument(withIdentity as never, 'en', {
    layout: DEFAULT_RECEIPT_LAYOUT,
    taxIdentity,
    reprint: true,
  }).receiptSnapshot!.facts;
  return {
    thermalEn: buildCounterReceiptPreview(withIdentity, 'en', 80),
    thermalUr: buildCounterReceiptPreview(withIdentity, 'ur', 80),
    a4: buildCounterBrowserReceipt(withIdentity, 'en', 'A4'),
    urduBrowser: buildCounterBrowserReceipt(withIdentity, 'ur', 'THERMAL'),
    escPos: JSON.stringify(escPos),
    escPosLabel: escPos.invoiceLabel,
  };
}

describe('#708 Sindh cash memo held for counsel', () => {
  it('is held by a hard-coded constant', () => {
    expect(SINDH_CASH_MEMO_LIVE).toBe(false);
    expect(SINDH_SPELLINGS.map(sindhCashMemoSelected)).toEqual(SINDH_SPELLINGS.map(() => false));
  });

  it.each(SINDH_SPELLINGS)(
    'sale completion chooses the ordinary receipt for a %s profile and records no buyer',
    async (provinceCode) => {
      const { db, payload } = await completeAt(provinceCode);
      // The automatic province selection ran against the in-force profile...
      expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: 'org_a', branchId: 'branch_a' }),
        })
      );
      // ...and the hold froze the ordinary receipt mode into the snapshot.
      expect(payload.cashMemoIdentity).toBeNull();
      expect(payload).not.toHaveProperty('buyerName');
    }
  );

  it('reads a sale completed under a Sindh profile back, and prints it, as an ordinary receipt', async () => {
    const { payload } = await completeAt('PK-SD');
    const receipt = await readBack(payload);
    expect(receipt.cashMemoIdentity).toBeNull();
    expect(receipt.buyerName).toBeNull();
    expect(counterReceiptCashMemo(receipt, sindhIdentity, 'en')).toBeNull();
    const prints = everyPrint(receipt, sindhIdentity);
    expect(prints.escPosLabel).toBe('Receipt');
    for (const [path, text] of Object.entries(prints)) {
      expect(text, path).not.toMatch(MEMO_TEXT);
    }
    // The ordinary receipt still carries the licence as it always has.
    expect(prints.thermalEn).toContain('Drug-sale licence: SYN-SD-77');
  });

  it('keeps an older receipt with no frozen mode ordinary under a Sindh profile', async () => {
    const { payload } = await completeAt('PK-SD');
    const older = { ...payload };
    delete older.cashMemoIdentity;
    const receipt = await readBack(older);
    expect(receipt).not.toHaveProperty('cashMemoIdentity');
    // Without the hold this receipt would fall back to the profile's province.
    expect(counterReceiptCashMemo(receipt, sindhIdentity, 'en')).toBeNull();
    const prints = everyPrint({ ...receipt, buyerName: 'Synthetic Buyer' }, sindhIdentity);
    expect(prints.escPosLabel).toBe('Receipt');
    for (const [path, text] of Object.entries(prints)) {
      expect(text, path).not.toMatch(MEMO_TEXT);
    }
  });

  it('prints a Sindh profile receipt byte-for-byte as the same receipt under Punjab', async () => {
    const sindhSale = await readBack((await completeAt('PK-SD')).payload);
    const punjabSale = await readBack((await completeAt('PK-PB')).payload);
    const punjab = { ...sindhIdentity, provinceCode: 'PK-PB' };
    expect(everyPrint(sindhSale, sindhIdentity)).toEqual(everyPrint(punjabSale, punjab));
  });

  it('keeps an already-issued memo exactly as it was frozen', () => {
    const issued = {
      buyerName: 'Synthetic Buyer',
      cashMemoIdentity: sindhIdentity,
    } satisfies Pick<CounterReceipt, 'buyerName' | 'cashMemoIdentity'>;
    expect(counterReceiptCashMemo(issued, null, 'en')).toMatchObject({
      buyer: 'Buyer: Synthetic Buyer',
    });
  });
});
