/**
 * PH-B3 — pure WhatsApp message rules: phone normalization, the consent gate,
 * STOP/START keywords and a deliberately small English / Roman-Urdu / Urdu
 * order grammar ("<medicine> <qty> <pack-unit>"). Anything outside the grammar
 * returns null so a pharmacist calls the customer instead of guessing.
 */

const URDU_DIGITS = /[۰-۹٠-٩]/g;

function asciiDigits(value: string): string {
  return value.replace(URDU_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * Normalizes a stored or inbound phone number to WhatsApp's international
 * digit form. Pakistani local forms (03xx…, 3xx…) gain the 92 country code.
 */
export function normalizeWhatsAppNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = asciiDigits(raw).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('03')) digits = `92${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('3')) digits = `92${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

export function phoneLast4(waId: string): string | null {
  const last4 = waId.slice(-4);
  return /^\d{4}$/.test(last4) ? last4 : null;
}

export type WhatsAppConsentSubject = { active: boolean; whatsappOptIn: boolean | null };

/** No message is sent unless the customer explicitly opted in (null = never asked). */
export function canMessageCustomer(customer: WhatsAppConsentSubject | null | undefined): boolean {
  return Boolean(customer?.active && customer.whatsappOptIn === true);
}

function normalizeText(text: string): string {
  return asciiDigits(text.normalize('NFKC'))
    .toLowerCase()
    .replace(/[×]/g, 'x')
    .replace(/[.,!?؟،۔;:'"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP_KEYWORDS = new Set([
  'stop',
  'stop all',
  'stopall',
  'unsubscribe',
  'opt out',
  'optout',
  'band karo',
  'band karein',
  'بند',
  'بند کریں',
  'بند کرو',
]);
const START_KEYWORDS = new Set([
  'start',
  'subscribe',
  'opt in',
  'optin',
  'shuru karo',
  'شروع',
  'شروع کریں',
]);

export function consentKeyword(text: string): 'STOP' | 'START' | null {
  const normalized = normalizeText(text);
  if (STOP_KEYWORDS.has(normalized)) return 'STOP';
  if (START_KEYWORDS.has(normalized)) return 'START';
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  ek: 1,
  teen: 3,
  char: 4,
  chaar: 4,
  panch: 5,
  paanch: 5,
  chay: 6,
  chhe: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
  ایک: 1,
  دو: 2,
  تین: 3,
  چار: 4,
  پانچ: 5,
  چھ: 6,
  سات: 7,
  آٹھ: 8,
  نو: 9,
  دس: 10,
};

const PACK_UNITS = new Set([
  'pack',
  'packs',
  'packet',
  'packets',
  'pkt',
  'pkts',
  'box',
  'boxes',
  'dabba',
  'dabbay',
  'dabbe',
  'dabbi',
  'پیک',
  'پیکٹ',
  'ڈبہ',
  'ڈبے',
  'ڈبی',
]);
/** Units the storefront cannot sell remotely: the message goes to a pharmacist. */
const UNSUPPORTED_UNITS = new Set([
  'strip',
  'strips',
  'patta',
  'pattay',
  'patte',
  'tablet',
  'tablets',
  'tab',
  'tabs',
  'goli',
  'goliyan',
  'پتا',
  'پتہ',
  'پتے',
  'گولی',
  'گولیاں',
]);
const STRENGTH_UNITS = new Set(['mg', 'ml', 'mcg', 'g', 'iu']);
const FILLER = new Set([
  'please',
  'pls',
  'plz',
  'kindly',
  'i',
  'need',
  'want',
  'send',
  'me',
  'order',
  'of',
  'a',
  'the',
  'mujhe',
  'mujhay',
  'chahiye',
  'chahye',
  'chaiye',
  'chahie',
  'bhej',
  'bhejo',
  'bhejein',
  'dein',
  'dedo',
  'ki',
  'ka',
  'ke',
  'hai',
  'مجھے',
  'چاہیے',
  'چاہئے',
  'چاہیئے',
  'بھیج',
  'بھیجیں',
  'دیں',
  'دیجیے',
  'کی',
  'کا',
  'کے',
  'ہے',
  'براہ',
  'کرم',
]);
/** Verb phrases whose second word would otherwise read as a number ("send two"). */
const VERB_PHRASES = /(?:^|\s)(?:bhej do|de do|بھیج دو|دے دو|دے دیں)(?=\s|$)/g;

export type ParsedOrderMessage = { medicine: string; quantity: number };

function numberFrom(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

export function parseOrderMessage(text: string): ParsedOrderMessage | null {
  let normalized = normalizeText(text).replace(VERB_PHRASES, ' ');
  // "x3" / "3x" multiplier shorthand becomes a plain quantity token.
  normalized = normalized.replace(/(?:^|\s)x\s?(\d+)(?=\s|$)/g, ' $1 pack ');
  normalized = normalized.replace(/(?:^|\s)(\d+)\s?x(?=\s|$)/g, ' $1 pack ');
  const tokens = normalized.split(' ').filter((token) => token && !FILLER.has(token));
  if (tokens.some((token) => UNSUPPORTED_UNITS.has(token))) return null;

  const quantityIndexes: number[] = [];
  tokens.forEach((token, index) => {
    const value = numberFrom(token);
    if (value === null) return;
    if (STRENGTH_UNITS.has(tokens[index + 1] ?? '')) return;
    quantityIndexes.push(index);
  });
  const beforeUnit = quantityIndexes.filter((index) => PACK_UNITS.has(tokens[index + 1] ?? ''));
  const quantityIndex =
    beforeUnit.length === 1
      ? beforeUnit[0]
      : beforeUnit.length === 0 && quantityIndexes.length === 1
        ? quantityIndexes[0]
        : undefined;
  if (quantityIndex === undefined) return null;

  const quantity = numberFrom(tokens[quantityIndex]!);
  if (quantity === null || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100)
    return null;

  const medicine = tokens
    .filter((token, index) => index !== quantityIndex && !PACK_UNITS.has(token))
    .join(' ')
    .trim();
  if (!/\p{L}/u.test(medicine) || medicine.length > 80) return null;
  return { medicine, quantity };
}

export const WHATSAPP_REPLIES = {
  fallback:
    'Thank you for your message. A pharmacist will call you shortly to help with your order.\n' +
    'آپ کے پیغام کا شکریہ۔ فارماسسٹ جلد آپ کو کال کریں گے۔',
  optedOut:
    'You will no longer receive WhatsApp messages from this pharmacy. Reply START to opt back in.\n' +
    'آپ کو اب اس فارمیسی سے واٹس ایپ پیغامات نہیں ملیں گے۔ دوبارہ شروع کرنے کے لیے START لکھیں۔',
  optedIn:
    'You are now subscribed to WhatsApp messages from this pharmacy. Reply STOP at any time to opt out.\n' +
    'آپ نے واٹس ایپ پیغامات کی اجازت دے دی ہے۔ بند کرنے کے لیے STOP لکھیں۔',
  confirmation(input: { reference: string; quantity: number; medicine: string; branch: string }) {
    return (
      `Order ${input.reference} received: ${input.quantity} x ${input.medicine} for collection at ${input.branch}. ` +
      'We will confirm when it is ready.\n' +
      `آپ کا آرڈر ${input.reference} موصول ہو گیا ہے: ${input.quantity} x ${input.medicine}، ${input.branch} سے وصول کرنے کے لیے۔ ` +
      'تیار ہونے پر ہم آپ کو اطلاع دیں گے۔'
    );
  },
} as const;
