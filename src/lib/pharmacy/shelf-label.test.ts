import { describe, expect, it } from 'vitest';

import {
  buildShelfLabelSheet,
  MAX_SHELF_LABELS_PER_PRINT,
  type ShelfLabelRow,
} from './shelf-label';
import { shelfLabelCode } from './shelf-label-code';

const row: ShelfLabelRow = {
  inventoryLotId: 'lot-a',
  code: shelfLabelCode(7),
  name: 'Paracetamol',
  strength: '500 mg',
  packMrpMinor: 12_000,
  stripMrpMinor: 1_200,
  expiry: '2027-06',
  batchNumber: 'B-17',
  defaultCount: 3,
  unavailableReason: null,
};

const labelsIn = (html: string) => html.match(/<section class="shelf-label"/g)?.length ?? 0;

describe('DEV-90 shelf and price sticker sheet', () => {
  it('prints name, strength, pack and strip MRP, expiry and the scannable lot code', () => {
    const html = buildShelfLabelSheet([{ row, count: 1 }], '38x25');
    expect(html).toContain('<strong>Paracetamol</strong> 500 mg');
    expect(html).toContain('MRP/pack <strong class="price">Rs 120.00</strong>');
    expect(html).toContain('strip <strong class="price">Rs 12.00</strong>');
    expect(html).toContain('EXP <strong>2027-06</strong>');
    expect(html).toContain(`aria-label="Lot barcode ${row.code}"`);
    expect(html).toContain(`<div class="code">${row.code}</div>`);
    // No patient directions: this is not the dispensing label.
    expect(html).not.toMatch(/dispensing-label|directions|patient/i);
  });

  it('prints one sticker per requested copy and skips lots set to zero', () => {
    const other = { ...row, inventoryLotId: 'lot-b', code: shelfLabelCode(8) };
    const html = buildShelfLabelSheet(
      [
        { row, count: 3 },
        { row: other, count: 0 },
      ],
      '50x25'
    );
    expect(labelsIn(html)).toBe(3);
    expect(html).not.toContain(other.code);
  });

  it('sizes each paper choice', () => {
    expect(buildShelfLabelSheet([{ row, count: 1 }], '38x25')).toContain(
      '@page { size: 38mm 25mm; margin: 0; }'
    );
    expect(buildShelfLabelSheet([{ row, count: 1 }], '50x25')).toContain(
      '@page { size: 50mm 25mm; margin: 0; }'
    );
    const a4 = buildShelfLabelSheet([{ row, count: 1 }], 'A4');
    expect(a4).toContain('@page { size: A4; margin: 10mm; }');
    expect(a4).toContain('grid-template-columns: repeat(3, 50mm)');
    expect(() => buildShelfLabelSheet([{ row, count: 1 }], 'A5' as never)).toThrow(
      /supported label size/
    );
  });

  it('omits the strip price when the pack has no strip', () => {
    const html = buildShelfLabelSheet([{ row: { ...row, stripMrpMinor: null }, count: 1 }], 'A4');
    expect(html).not.toContain('strip');
  });

  it('refuses to label a lot that cannot be sold', () => {
    expect(() =>
      buildShelfLabelSheet(
        [{ row: { ...row, unavailableReason: 'This batch is recalled.' }, count: 1 }],
        '38x25'
      )
    ).toThrow('Batch B-17: This batch is recalled.');
  });

  it('refuses empty, fractional and oversized requests', () => {
    expect(() => buildShelfLabelSheet([{ row, count: 0 }], '38x25')).toThrow(/between 1 and/);
    expect(() => buildShelfLabelSheet([{ row, count: 1.5 }], '38x25')).toThrow(/whole number/);
    expect(() =>
      buildShelfLabelSheet([{ row, count: MAX_SHELF_LABELS_PER_PRINT + 1 }], '38x25')
    ).toThrow(/between 1 and/);
  });

  it('escapes catalogue text and rejects bidi overrides, bad codes and bad expiries', () => {
    const html = buildShelfLabelSheet(
      [{ row: { ...row, name: '<img src=x onerror=alert(1)>' }, count: 1 }],
      '38x25'
    );
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(() =>
      buildShelfLabelSheet([{ row: { ...row, name: 'Para‮cetamol' }, count: 1 }], '38x25')
    ).toThrow(/medicine name/);
    expect(() =>
      buildShelfLabelSheet(
        [
          {
            row: { ...row, code: `${row.code.slice(0, -1)}${(Number(row.code.at(-1)) + 1) % 10}` },
            count: 1,
          },
        ],
        '38x25'
      )
    ).toThrow(/lot code/);
    expect(() =>
      buildShelfLabelSheet([{ row: { ...row, expiry: '2027-13' }, count: 1 }], '38x25')
    ).toThrow(/expiry/);
    expect(() =>
      buildShelfLabelSheet([{ row: { ...row, packMrpMinor: -1 }, count: 1 }], '38x25')
    ).toThrow(/pack MRP/);
  });
});
