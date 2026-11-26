import type { CounterReceipt } from './counter-receipt';

/** Fictional settled facts shared by the designer and rendering regressions. */
export const receiptDesignSample: CounterReceipt = {
  saleId: 'sample',
  receiptNumber: 101,
  completedAt: '2026-10-01T06:15:00Z',
  businessDate: '2026-10-01',
  branchName: 'Sample Community Pharmacy at the Old Railway Station',
  counterLabel: 'Counter 2',
  currency: 'PKR',
  taxIdentity: {
    registeredName: 'Example Registered Pharmacy',
    address: '12 Sample Road',
    licenceNumber: 'SAMPLE-LIC',
    ntn: 'SAMPLE-NTN',
    strn: 'SAMPLE-STRN',
  },
  lines: [
    {
      saleLineId: 'sample-line',
      identityStatus: 'ISSUED',
      medicineName: 'Sample extended release medicine with a long printed name',
      strength: '250 mg',
      presentation: 'Tablet',
      batchNumber: 'SAMPLE',
      expiresAt: null,
      saleUnit: 'UNIT',
      quantity: 2,
      canonicalUnits: 2,
      unitPriceMinor: 1500,
      discountMinor: 100,
      lineTotalMinor: 2900,
    },
  ],
  tenders: [
    {
      tenderId: 'sample-cash',
      type: 'CASH',
      amountMinor: 2900,
      cashReceivedMinor: 3000,
      changeGivenMinor: 100,
    },
  ],
  totals: {
    grossMinor: 3000,
    discountMinor: 100,
    netMinor: 2900,
    tenderedMinor: 3000,
    changeMinor: 100,
  },
};
