/**
 * DEV-851 — an invented product catalogue in the shape of the legacy desktop
 * export used for the first real handover (18,933 products). Only the headers
 * match that export; every product, code, company and price here is synthetic.
 */
export const LEGACY_CATALOGUE_HEADERS =
  'Name,aliasname,Company,PackUnits,saleprice,purprice,QTY,active';

const FORMS = ['TAB', 'CAP', 'SYRUP', 'INJ', 'CREAM', 'DROPS', 'SACHET', 'SUSP'];
const PACKS = ['10.0000', '14.0000', '20.0000', '30.0000', '1.0000', '3X10', '100.0000'];

/** A deterministic, invented catalogue in the legacy export's shape. */
export function syntheticLegacyCatalogue(rows: number): string {
  const lines = [LEGACY_CATALOGUE_HEADERS];
  let seed = 851;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let index = 1; index <= rows; index += 1) {
    const sale = 50 + (next() % 500000) / 100;
    const name = `SYNTH ${next().toString(36).toUpperCase()} ${FORMS[index % FORMS.length]} ${
      (next() % 995) + 5
    }MG ${index}`;
    lines.push(
      [
        name,
        `LC-${String(index).padStart(6, '0')}`,
        `Synthetic Labs ${(next() % 240) + 1}`,
        PACKS[next() % PACKS.length],
        sale.toFixed(4),
        (sale * 0.85).toFixed(4),
        `${next() % 400}.0000`,
        String(next() % 2),
      ].join(',')
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
