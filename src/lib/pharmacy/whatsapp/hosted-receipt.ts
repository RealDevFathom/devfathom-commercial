import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const MIN_DAYS = 30;
const MAX_DAYS = 90;
const PURPOSE = 'pharmacy-hosted-receipt-v1';
const OTP_PURPOSE = 'pharmacy-hosted-receipt-otp-v1';

export type ReceiptConsent = 'CUSTOMER_REQUEST' | 'COUNTER_OPT_IN';
export type HostedReceipt = {
  branch: string;
  receiptNumber: string;
  total: string;
  paymentMethod: string;
  issuedAt: string;
  expiresAt: string;
  rx: boolean;
  phoneBinding: string | null;
  fbrInvoiceNumber?: string;
  fbrQrUrl?: string;
};

type Claims = HostedReceipt & { purpose: typeof PURPOSE; nonce: string };
function parseClaims(value: unknown): Claims {
  if (!value || typeof value !== 'object') throw new Error('Invalid claims.');
  const c = value as Record<string, unknown>;
  if (
    c.purpose !== PURPOSE ||
    typeof c.nonce !== 'string' ||
    c.nonce.length < 32 ||
    typeof c.branch !== 'string' ||
    typeof c.receiptNumber !== 'string' ||
    typeof c.total !== 'string' ||
    typeof c.paymentMethod !== 'string' ||
    typeof c.issuedAt !== 'string' ||
    typeof c.expiresAt !== 'string' ||
    typeof c.rx !== 'boolean' ||
    (c.phoneBinding !== null && typeof c.phoneBinding !== 'string') ||
    (c.fbrInvoiceNumber !== undefined && typeof c.fbrInvoiceNumber !== 'string') ||
    (c.fbrQrUrl !== undefined && typeof c.fbrQrUrl !== 'string')
  )
    throw new Error('Invalid claims.');
  return c as Claims;
}

function key(secret: string) {
  if (secret.length < 32)
    throw new Error('Receipt-link secret must contain at least 32 characters.');
  return createHmac('sha256', secret).update(PURPOSE).digest();
}
function b64(value: Buffer) {
  return value.toString('base64url');
}
function unb64(value: string) {
  return Buffer.from(value, 'base64url');
}
export function phoneBinding(secret: string, e164Phone: string) {
  return createHmac('sha256', key(secret)).update(e164Phone.replace(/\D/g, '')).digest('hex');
}

export function issueHostedReceipt(
  input: Omit<HostedReceipt, 'issuedAt' | 'expiresAt' | 'phoneBinding'> & {
    consent: ReceiptConsent;
    phone?: string;
    expiryDays: number;
    now?: Date;
  },
  secret: string
): { token: string; receipt: HostedReceipt } {
  if (
    !Number.isInteger(input.expiryDays) ||
    input.expiryDays < MIN_DAYS ||
    input.expiryDays > MAX_DAYS
  )
    throw new Error('Hosted receipt expiry must be between 30 and 90 days.');
  if (input.rx && !input.phone) throw new Error('An Rx receipt requires a phone for OTP binding.');
  const now = input.now ?? new Date();
  const receipt: HostedReceipt = {
    branch: input.branch,
    receiptNumber: input.receiptNumber,
    total: input.total,
    paymentMethod: input.paymentMethod,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.expiryDays * 86_400_000).toISOString(),
    rx: input.rx,
    phoneBinding: input.phone ? phoneBinding(secret, input.phone) : null,
    ...(input.fbrInvoiceNumber ? { fbrInvoiceNumber: input.fbrInvoiceNumber } : {}),
    ...(input.fbrQrUrl ? { fbrQrUrl: input.fbrQrUrl } : {}),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ purpose: PURPOSE, nonce: b64(randomBytes(24)), ...receipt })),
    cipher.final(),
  ]);
  return { token: [b64(iv), b64(encrypted), b64(cipher.getAuthTag())].join('.'), receipt };
}

export function readHostedReceipt(token: string, secret: string, now = new Date()): HostedReceipt {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid receipt link.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(secret), unb64(parts[0]));
    decipher.setAuthTag(unb64(parts[2]));
    const claims = parseClaims(
      JSON.parse(
        Buffer.concat([decipher.update(unb64(parts[1])), decipher.final()]).toString('utf8')
      )
    );
    if (new Date(claims.expiresAt).getTime() <= now.getTime())
      throw new Error('Receipt link has expired.');
    const { purpose: _purpose, nonce: _nonce, ...receipt } = claims;
    return receipt;
  } catch (error) {
    if (error instanceof Error && error.message === 'Receipt link has expired.') throw error;
    throw new Error('Invalid receipt link.');
  }
}

export function createReceiptOtpProof(
  token: string,
  phone: string,
  secret: string,
  verifiedAt = new Date()
) {
  const receipt = readHostedReceipt(token, secret, verifiedAt);
  if (!receipt.rx || !receipt.phoneBinding || receipt.phoneBinding !== phoneBinding(secret, phone))
    throw new Error('OTP verification does not match this receipt.');
  const timestamp = String(verifiedAt.getTime());
  const signature = createHmac('sha256', key(secret))
    .update(`${OTP_PURPOSE}.${token}.${timestamp}.${receipt.phoneBinding}`)
    .digest();
  return `${timestamp}.${b64(signature)}`;
}
export function hasValidReceiptOtp(
  token: string,
  proof: string | undefined,
  secret: string,
  now = new Date()
) {
  if (!proof) return false;
  const receipt = readHostedReceipt(token, secret, now);
  if (!receipt.rx || !receipt.phoneBinding) return !receipt.rx;
  const [timestamp, encoded] = proof.split('.');
  const verifiedAt = Number(timestamp);
  if (
    !Number.isSafeInteger(verifiedAt) ||
    verifiedAt > now.getTime() ||
    now.getTime() - verifiedAt > 15 * 60_000
  )
    return false;
  const expected = createHmac('sha256', key(secret))
    .update(`${OTP_PURPOSE}.${token}.${timestamp}.${receipt.phoneBinding}`)
    .digest();
  const actual = unb64(encoded ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const SAFE_TEMPLATE =
  'Receipt from {{branch}}\nReceipt: {{receiptNumber}}\nTotal: {{total}}\nMethod: {{paymentMethod}}\nSecure receipt: {{link}}';
export function lintReceiptMessage(message: string, prohibitedTerms: readonly string[] = []) {
  const normalized = message.toLocaleLowerCase();
  const prohibited = prohibitedTerms.find(
    (term) => term.trim() && normalized.includes(term.trim().toLocaleLowerCase())
  );
  if (prohibited) throw new Error('WhatsApp receipt must not contain medicine information.');
  const lines = message.split('\n');
  if (lines.length !== 5 || !lines[4]?.startsWith('Secure receipt: https://'))
    throw new Error('WhatsApp receipt is not the approved utility format.');
}
export function buildReceiptMessage(
  values: {
    branch: string;
    receiptNumber: string;
    total: string;
    paymentMethod: string;
    link: string;
  },
  prohibitedTerms: readonly string[] = []
) {
  const message = SAFE_TEMPLATE.replace('{{branch}}', values.branch)
    .replace('{{receiptNumber}}', values.receiptNumber)
    .replace('{{total}}', values.total)
    .replace('{{paymentMethod}}', values.paymentMethod)
    .replace('{{link}}', values.link);
  lintReceiptMessage(message, prohibitedTerms);
  return message;
}
