// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildPackingSlipText, type PackingSlip, type PackingSlipLine } from './packing-slip';

const line = (overrides: Partial<PackingSlipLine> = {}): PackingSlipLine => ({
  medicineName: 'Panadol 500 mg',
  batchNumber: 'B-1',
  expiresAt: '2027-04-30T19:00:00.000Z',
  sourceLocation: 'Main store',
  destinationLocation: 'Branch shelf',
  quantityUnits: 20,
  sealedPacks: 2,
  looseUnits: 0,
  unitsPerPack: 10,
  ...overrides,
});

const slip = (lines: PackingSlipLine[]): PackingSlip => ({
  reference: 'TR-1',
  status: 'APPROVED',
  fromBranch: 'Main',
  toBranch: 'Clifton',
  allocatedBy: 'Asma',
  approvedBy: 'Bilal',
  dispatchedBy: null,
  dispatchedAt: null,
  lines,
});

describe('packing slip expiry (QA-3)', () => {
  it('prints "No expiry" for a non-drug lot, never the 9998-12-31 storage marker', () => {
    const text = buildPackingSlipText(
      slip([
        line(),
        line({
          medicineName: 'Baby lotion',
          batchNumber: 'RETAIL-NOEXP',
          expiresAt: '9998-12-31T19:00:00.000Z',
        }),
      ]),
      48
    );
    expect(text).toContain('Batch B-1 · exp 2027-04-30');
    expect(text).toContain('Batch RETAIL-NOEXP · No expiry');
    expect(text).not.toContain('9998');
  });
});
