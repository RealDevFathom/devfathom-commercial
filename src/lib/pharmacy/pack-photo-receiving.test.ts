import { describe, expect, it } from 'vitest';
import {
  checkPackPhotoLot,
  defaultReceivingLocationId,
  findRepeatedLot,
  lotSlotKey,
  MAX_PACKS_PER_LOT,
  sameLotKey,
  type PackPhotoLotDraft,
} from './pack-photo-receiving';

const draft = (overrides: Partial<PackPhotoLotDraft> = {}): PackPhotoLotDraft => ({
  batch: 'SYN-B2741',
  expiryDate: '2028-06-30',
  precision: 'MONTH',
  packs: '12',
  confirmedSameLot: true,
  serialPrinted: false,
  serialLocked: false,
  unitsPerPack: 10,
  outstandingPacks: 20,
  ...overrides,
});

describe('checkPackPhotoLot', () => {
  it('turns a reviewed same-lot count into packs and server-converted units', () => {
    expect(checkPackPhotoLot(draft())).toEqual({
      ok: true,
      lot: {
        batchNumber: 'SYN-B2741',
        printedExpiry: '2028-06-30',
        expiryPrecision: 'MONTH',
        receivedPacks: 12,
        canonicalUnits: 120,
      },
      notes: [],
    });
  });

  it('keeps an edited batch and expiry exactly as the receiver typed them', () => {
    const result = checkPackPhotoLot(
      draft({ batch: '  syn-b2799 ', expiryDate: '2028-02-29', precision: 'DAY' })
    );
    expect(result).toMatchObject({
      ok: true,
      lot: { batchNumber: 'syn-b2799', printedExpiry: '2028-02-29', expiryPrecision: 'DAY' },
    });
  });

  it('requires an explicit same-lot confirmation; confidence is never approval', () => {
    expect(checkPackPhotoLot(draft({ confirmedSameLot: false }))).toMatchObject({
      ok: false,
      errors: { confirm: expect.any(String) },
    });
  });

  it.each(['', ' ', '0', '-1', '1.5', '2e3', 'twelve', String(MAX_PACKS_PER_LOT + 1)])(
    'rejects the pack count %j',
    (packs) => {
      expect(checkPackPhotoLot(draft({ packs }))).toMatchObject({
        ok: false,
        errors: { packs: expect.any(String) },
      });
    }
  );

  it('never treats the photographed pack as the delivered total', () => {
    // An empty count is refused rather than defaulted to the one photographed pack.
    expect(checkPackPhotoLot(draft({ packs: '' }))).toMatchObject({ ok: false });
  });

  it.each([
    ['missing', ''],
    ['with spaces', 'SYN B2741'],
    ['with injected markup', '<b>SYN</b>'],
    ['too long', `A${'1'.repeat(120)}`],
  ])('rejects a batch that is %s', (_label, batch) => {
    expect(checkPackPhotoLot(draft({ batch }))).toMatchObject({
      ok: false,
      errors: { batch: expect.any(String) },
    });
  });

  it.each([
    ['empty', '', 'MONTH'],
    ['not a calendar day', '2027-02-30', 'DAY'],
    ['out of range', '1999-12-31', 'DAY'],
    ['unresolved ambiguity (no precision chosen)', '2028-04-03', ''],
  ] as const)('rejects an expiry that is %s', (_label, expiryDate, precision) => {
    expect(checkPackPhotoLot(draft({ expiryDate, precision }))).toMatchObject({
      ok: false,
      errors: { expiry: expect.any(String) },
    });
  });

  it.each([
    ['a printed serial', { serialPrinted: true }],
    ['a scanned GS1 serial on the line', { serialLocked: true }],
  ])('refuses a bulk count for %s but allows one pack', (_label, serial) => {
    expect(checkPackPhotoLot(draft({ ...serial, packs: '5' }))).toMatchObject({
      ok: false,
      errors: { packs: expect.stringMatching(/one at a time/) },
    });
    expect(checkPackPhotoLot(draft({ ...serial, packs: '1' }))).toMatchObject({ ok: true });
  });

  it('allows an over-delivery but says posting raises the existing exception', () => {
    const result = checkPackPhotoLot(draft({ packs: '25', outstandingPacks: 20 }));
    expect(result).toMatchObject({ ok: true, lot: { receivedPacks: 25 } });
    expect(result.ok && result.notes[0]).toMatch(/over-receipt exception/);
  });

  it('refuses a line without a pack conversion', () => {
    expect(checkPackPhotoLot(draft({ unitsPerPack: 0 }))).toMatchObject({ ok: false });
  });
});

describe('lot identity', () => {
  it('treats the same batch and expiry as one lot regardless of case or padding', () => {
    expect(sameLotKey(' syn-b1 ', '2028-06-30')).toBe(sameLotKey('SYN-B1', '2028-06-30'));
  });

  it('treats a different batch or expiry as a separate lot', () => {
    expect(sameLotKey('SYN-B1', '2028-06-30')).not.toBe(sameLotKey('SYN-B2', '2028-06-30'));
    expect(sameLotKey('SYN-B1', '2028-06-30')).not.toBe(sameLotKey('SYN-B1', '2028-07-31'));
  });

  it('keeps the first lot on the existing capture key', () => {
    expect(lotSlotKey('pol-1', 1)).toBe('pol-1');
    expect(lotSlotKey('pol-1', 2)).toBe('pol-1.lot2');
  });
});

describe('defaultReceivingLocationId', () => {
  const shelf = (id: string, kind = 'STORE') => ({ id, kind });

  it("starts on the branch's own receiving default", () => {
    expect(
      defaultReceivingLocationId('b', [shelf('a'), shelf('b'), shelf('q', 'QUARANTINE')])
    ).toBe('b');
  });

  it('falls back to the only receiving location when there is no valid default', () => {
    expect(defaultReceivingLocationId(null, [shelf('a'), shelf('q', 'QUARANTINE')])).toBe('a');
    expect(defaultReceivingLocationId('gone', [shelf('a')])).toBe('a');
  });

  it('never pre-selects a quarantine location, even when it is the branch default', () => {
    expect(defaultReceivingLocationId('q', [shelf('q', 'QUARANTINE')])).toBeUndefined();
    expect(defaultReceivingLocationId('q', [shelf('a'), shelf('q', 'QUARANTINE')])).toBe('a');
  });

  it('chooses nothing rather than guessing between several shelves', () => {
    expect(defaultReceivingLocationId(null, [shelf('a'), shelf('b')])).toBeUndefined();
    expect(defaultReceivingLocationId('other-branch', [shelf('a'), shelf('b')])).toBeUndefined();
  });

  it('fabricates nothing when the branch has no location', () => {
    expect(defaultReceivingLocationId('a', [])).toBeUndefined();
  });
});

describe('findRepeatedLot', () => {
  const lot = (overrides: Record<string, unknown> = {}) => ({
    purchaseOrderLineId: 'pol-1',
    batchNumber: 'SYN-A1',
    printedExpiry: new Date('2028-06-30T00:00:00.000Z'),
    ...overrides,
  });

  it('refuses the same batch and expiry twice on one order line, case-insensitively', () => {
    const repeated = lot({ batchNumber: 'syn-a1' });
    expect(findRepeatedLot([lot(), repeated])).toBe(repeated);
  });

  it('accepts a mixed-lot split and the same lot on different order lines', () => {
    expect(
      findRepeatedLot([
        lot(),
        lot({ batchNumber: 'SYN-A2' }),
        lot({ printedExpiry: new Date('2028-07-31T00:00:00.000Z') }),
        lot({ purchaseOrderLineId: 'pol-2' }),
      ])
    ).toBeNull();
  });

  it('exempts serialized packs, which share a lot one pack per line', () => {
    expect(
      findRepeatedLot([
        lot({ serialNumber: 'S1' }),
        lot({ serialNumber: 'S2' }),
        lot({ gs1Payload: ']d2010...|21S3' }),
      ])
    ).toBeNull();
  });
});
