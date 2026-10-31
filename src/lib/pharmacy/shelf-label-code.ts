/**
 * #719 internal lot barcode: `71` + the lot's 14-digit zero-padded shelf-label
 * number. Sixteen digits is never a GTIN length (8/12/13/14), so a label can
 * not be mistaken for a manufacturer code, and it encodes as Code128 set C.
 */
const SHELF_LABEL_CODE = /^71\d{14}$/;
const MAX_LABEL_NUMBER = 2_147_483_647; // Postgres SERIAL ceiling.

export function shelfLabelCode(number: number): string {
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_LABEL_NUMBER) {
    throw new Error('Lot label number is outside the supported range.');
  }
  return `71${String(number).padStart(14, '0')}`;
}

/** The lot alias a scanned label carries, or null when the scan is not one. */
export function parseShelfLabelCode(value: string): number | null {
  const trimmed = value.trim();
  if (!SHELF_LABEL_CODE.test(trimmed)) return null;
  const number = Number(trimmed.slice(2));
  return Number.isSafeInteger(number) && number > 0 && number <= MAX_LABEL_NUMBER ? number : null;
}

// ISO/IEC 15417 symbol widths: alternating bars/spaces; stop has seven runs.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
] as const;

/** Sixteen digits = 123 symbol modules + two ten-module quiet zones = 143 modules. */
export function shelfLabelBarcodeSvg(code: string): string {
  if (parseShelfLabelCode(code) === null) throw new Error('Invalid internal lot barcode.');
  const data = code.trim().match(/\d{2}/g)!.map(Number);
  const checksum = (105 + data.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
  const symbols = [105, ...data, checksum, 106];
  let x = 10;
  const bars: string[] = [];
  for (const symbol of symbols) {
    [...PATTERNS[symbol]!].forEach((run, index) => {
      const width = Number(run);
      if (index % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${width}" height="24"/>`);
      x += width;
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Lot barcode ${code}" viewBox="0 0 ${x + 10} 24" width="35.8mm" height="6mm" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><g fill="black">${bars.join('')}</g></svg>`;
}
