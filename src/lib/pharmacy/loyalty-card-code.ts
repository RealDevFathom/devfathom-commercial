/**
 * DEV-748: the code printed in a physical loyalty card's QR. It is an opaque random token:
 * a fixed prefix and 26 base32 characters (128 random bits). It never contains the customer's
 * name, phone, balance or any internal id. Shared by the server and the counter, so it holds no
 * secret and no crypto: generation and hashing live in `loyalty-card.ts`.
 *
 * Only uppercase letters and the digits 2-7 are used, so a scanner typing through a keyboard
 * layout, or a cashier typing it by hand, cannot introduce ambiguous characters.
 */
export const LOYALTY_CARD_PREFIX = 'DFLC';
export const LOYALTY_CARD_RANDOM_CHARS = 26;
const CARD_CODE = new RegExp(`^${LOYALTY_CARD_PREFIX}[A-Z2-7]{${LOYALTY_CARD_RANDOM_CHARS}}$`);

/**
 * The canonical form of a scanned or typed card code, or null when the text is not one.
 * Case, spaces and hyphens are ignored, so a card read with caps lock on, or typed in groups,
 * still resolves.
 */
export function normalizeLoyaltyCardCode(text: string): string | null {
  if (text.length > 64) return null;
  const code = text.replace(/[\s-]/g, '').toUpperCase();
  return CARD_CODE.test(code) ? code : null;
}

/**
 * True for text that is, or is on its way to being, a card code: the counter must not run a
 * medicine search on it while a scanner is still typing.
 */
export function looksLikeLoyaltyCardCode(text: string): boolean {
  return text.trim().toUpperCase().startsWith(LOYALTY_CARD_PREFIX);
}

/** The code in groups of four, for the manual-entry line printed under the QR. */
export function formatLoyaltyCardCode(code: string): string {
  return code.match(/.{1,4}/g)?.join(' ') ?? code;
}
