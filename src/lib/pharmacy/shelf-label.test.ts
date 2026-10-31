import { describe, expect, it } from 'vitest';

import { buildShelfLabels, type ShelfLabelSource } from './shelf-label';
import { shelfLabelCode } from './shelf-label-code';

const row = (overrides: Partial<ShelfLabelSource> = {}): ShelfLabelSource => ({
  inventoryLotId: 'lot_1',
  code: shelfLabelCode(17),
  name: 'Panadol',
  strength: '500 mg',
  packMrpMinor: 30_000,
  stripMrpMinor: 10_000,
  expiry: '2027-06',
  batchNumber: 'B-1',
  count: 2,
  ...overrides,
});

const labelsIn = (html: string) => html.match(/<section class="shelf-label"/g)?.length ?? 0;

describe('#719 shelf and price label document', () => {
  it('prints one label per requested count with name, strength, both MRPs, expiry and the lot code', () => {
    const html = buildShelfLabels([row(), row({ inventoryLotId: 'lot_2', code: shelfLabelCode(18), count: 3 })], '38x25');
    expect(labelsIn(html)).toBe(5);
    expect(html).toContain('<strong>Panadol</strong>');
    expect(html).toContain('500 mg');
    expect(html).toContain('MRP/pack: PKR 300.00');
    expect(html).toContain('MRP/strip: PKR 100.00');
    expect(html).toContain('EXP 2027-06');
    expect(html).toContain('7100000000000017');
    expect(html).toContain('7100000000000018');
    expect(html).toContain('aria-label="Lot barcode 7100000000000017"');
  });

  it('sizes the page for 38×25 and 50×25 thermal rolls and an A4 sheet', () => {
    expect(buildShelfLabels([row()], '38x25')).toContain('size: 38mm 25mm');
    expect(buildShelfLabels([row()], '50x25')).toContain('size: 50mm 25mm');
    const a4 = buildShelfLabels([row()], 'A4');
    expect(a4).toContain('size: A4');
    expect(a4).toContain('grid-template-columns: repeat(3, 50mm)');
  });

  it('says N/A when the pack has no strip, and omits zero-count lots', () => {
    const html = buildShelfLabels([row({ stripMrpMinor: null, count: 1 }), row({ inventoryLotId: 'x', count: 0 })], 'A4');
    expect(labelsIn(html)).toBe(1);
    expect(html).toContain('MRP/strip: N/A');
  });

  it('escapes catalogue text so a medicine name cannot inject markup', () => {
    const html = buildShelfLabels([row({ name: '<img src=x onerror=alert(1)>', strength: '"5" & <b>', count: 1 })], '50x25');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;5&quot; &amp; &lt;b&gt;');
  });

  it('refuses to render an unavailable selection while allowing an omitted unavailable lot', () => {
    const unavailable = row({ unavailableReason: 'Resolve the registered barcode.' });
    expect(() => buildShelfLabels([unavailable], '38x25')).toThrow('Resolve the registered barcode.');
    expect(labelsIn(buildShelfLabels([row(), { ...unavailable, count: 0 }], '38x25'))).toBe(2);
  });

  it('refuses unsupported sizes, empty or oversized runs, and invalid money or expiry', () => {
    expect(() => buildShelfLabels([row()], 'Letter' as never)).toThrow('supported label size');
    expect(() => buildShelfLabels([], '38x25')).toThrow();
    expect(() => buildShelfLabels([row({ count: 0 })], '38x25')).toThrow();
    expect(() => buildShelfLabels([row({ count: 5001 })], '38x25')).toThrow();
    expect(() => buildShelfLabels([row({ count: 2500 }), row({ count: 2501 })], '38x25')).toThrow();
    expect(() => buildShelfLabels([row({ packMrpMinor: -1 })], '38x25')).toThrow();
    expect(() => buildShelfLabels([row({ packMrpMinor: 1.5 })], '38x25')).toThrow();
    expect(() => buildShelfLabels([row({ expiry: 'soon' })], '38x25')).toThrow();
    expect(() => buildShelfLabels([row({ code: '8964000000017' })], '38x25')).toThrow();
  });
});
