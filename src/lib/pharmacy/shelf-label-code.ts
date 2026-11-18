/**
 * DEV-90 — the internal lot barcode printed on shelf and price stickers.
 *
 * A sticker identifies one received lot, not a product: scanning it at the
 * counter must select that exact batch, its expiry and its printed MRP. The
 * code is `71`, the lot's 13-digit shelf-label number and a mod-10 check digit
 * — sixteen digits, which is never a GTIN length (8/12/13/14), so it cannot be
 * mistaken for a manufacturer barcode. All digits encode as Code128 set C,
 * which keeps the symbol narrow enough to scan from 38 mm thermal stock.
 *
 * Pure and dependency free: the counter (browser) and the label sheet builder
 * both parse and render it.
 */

const PREFIX = '71';
const NUMBER_DIGITS = 13;
const LABEL_CODE = /^71\d{14}$/;
/** The Postgres SERIAL ceiling for `shelfLabelNumber`. */
export const MAX_SHELF_LABEL_NUMBER = 2_147_483_647;

function checkDigit(body: string): number {
  // GS1-style weights (3,1,…) from the rightmost body digit.
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const digit = Number(body[body.length - 1 - index]);
    sum += digit * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** The sixteen-digit code for a lot's shelf-label number. */
export function shelfLabelCode(labelNumber: number): string {
  if (
    !Number.isSafeInteger(labelNumber) ||
    labelNumber <= 0 ||
    labelNumber > MAX_SHELF_LABEL_NUMBER
  ) {
    throw new Error('Lot label number is outside the supported range.');
  }
  const body = `${PREFIX}${String(labelNumber).padStart(NUMBER_DIGITS, '0')}`;
  return `${body}${checkDigit(body)}`;
}

/**
 * The lot's shelf-label number carried by a scanned or typed code, or null
 * when the text is not a valid shelf label (wrong shape or check digit). A
 * mistyped digit therefore never resolves to some other lot.
 */
export function parseShelfLabelCode(value: string): number | null {
  const trimmed = value.trim();
  if (!LABEL_CODE.test(trimmed)) return null;
  const body = trimmed.slice(0, -1);
  if (checkDigit(body) !== Number(trimmed.at(-1))) return null;
  const labelNumber = Number(body.slice(PREFIX.length));
  return labelNumber > 0 && labelNumber <= MAX_SHELF_LABEL_NUMBER ? labelNumber : null;
}

// ISO/IEC 15417 symbol widths, values 0..106: bar, space, bar, space, bar, space
// (the stop symbol adds a final bar).
// prettier-ignore
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
const START_C = 105;
const STOP = 106;
const QUIET_ZONE_MODULES = 10;

/**
 * The Code128 (set C) module string for a shelf-label code: `1` is a bar
 * module, `0` a space, quiet zones excluded.
 */
export function shelfLabelBarcodeModules(code: string): string {
  if (parseShelfLabelCode(code) === null) throw new Error('Invalid internal lot barcode.');
  const pairs = code.trim().match(/\d{2}/g)!.map(Number);
  const checksum =
    (START_C + pairs.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
  let modules = '';
  for (const symbol of [START_C, ...pairs, checksum, STOP]) {
    [...PATTERNS[symbol]!].forEach((run, index) => {
      modules += (index % 2 === 0 ? '1' : '0').repeat(Number(run));
    });
  }
  return modules;
}

/** An inline SVG of the code, monochrome, with quiet zones, sized for print. */
export function shelfLabelBarcodeSvg(code: string, widthMm: number, heightMm: number): string {
  const modules = shelfLabelBarcodeModules(code);
  const total = modules.length + QUIET_ZONE_MODULES * 2;
  const bars: string[] = [];
  let start = -1;
  for (let index = 0; index <= modules.length; index += 1) {
    if (modules[index] === '1') {
      if (start < 0) start = index;
    } else if (start >= 0) {
      bars.push(
        `<rect x="${start + QUIET_ZONE_MODULES}" y="0" width="${index - start}" height="20"/>`
      );
      start = -1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Lot barcode ${code}" viewBox="0 0 ${total} 20" width="${widthMm}mm" height="${heightMm}mm" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="${total}" height="20" fill="white"/><g fill="black">${bars.join('')}</g></svg>`;
}
