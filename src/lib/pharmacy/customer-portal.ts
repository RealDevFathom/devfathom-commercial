import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { currentPharmacyBusinessDate } from './business-day-clock';

import { readCustomerSnapshot } from './customer-loyalty';
import { readKhataBalance } from './family-khata';
import { recordKhataRepayment } from './khata-repayment';
import { requireCurrentPharmacyBusinessDate } from './settlement';
import { manualPaymentSettingsSchema } from './manual-payments';
import { isNonDrugOfferCopy } from './rfm-winback';
import type { LedgerScope } from './stock-ledger';
import { normalizeWhatsAppNumber } from './whatsapp/messages';
import type { WhatsAppConfig, WhatsAppProvider } from './whatsapp/provider';

/**
 * DEV-15 (#762): customer PWA ("My pharmacy"). A staff member mints a link for
 * exactly one customer and shares it by WhatsApp, SMS or a printed QR. The link
 * only opens a session after a one-time code, sent to that customer's stored
 * phone, is entered, so every session is scoped to that one customer.
 */

export const PORTAL_LINK_TTL_MS = 30 * 24 * 60 * 60_000;
export const PORTAL_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const PORTAL_OTP_TTL_MS = 10 * 60_000;
export const PORTAL_OTP_MAX_ATTEMPTS = 5;
export const PORTAL_SESSION_COOKIE = 'df_pharmacy_portal';
export const PORTAL_LINK_PATTERN = /^pcl_[0-9a-hjkmnp-tv-z]{26}$/;
const SESSION_PATTERN = /^pcs_[A-Za-z0-9_-]{43}$/;
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

export type PortalRequestKind = 'REFILL' | 'RX_ORDER' | 'KHATA_PAYMENT';
export type PortalRequestStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'CANCELLED';
export type PortalSession = {
  sessionId: string;
  organizationId: string;
  branchId: string;
  customerId: string;
};

export class PharmacyPortalError extends Error {
  constructor(
    readonly reason:
      | 'CUSTOMER_NOT_FOUND'
      | 'PHONE_REQUIRED'
      | 'LINK_INVALID'
      | 'LINK_LOCKED'
      | 'CODE_INVALID'
      | 'SEND_FAILED'
      | 'SALE_NOT_FOUND'
      | 'ACCOUNT_NOT_FOUND'
      | 'RAAST_NOT_CONFIGURED'
      | 'REQUEST_NOT_FOUND'
      | 'INVALID_STATE'
      | 'KIND_NOT_ALLOWED'
  ) {
    super(reason);
    this.name = 'PharmacyPortalError';
  }
}

export function hashPortalSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function opaqueLinkToken(): string {
  const bits = Array.from(randomBytes(16), (byte) => byte.toString(2).padStart(8, '0'))
    .join('')
    .padStart(130, '0');
  let encoded = '';
  for (let index = 0; index < bits.length; index += 5)
    encoded += CROCKFORD[Number.parseInt(bits.slice(index, index + 5), 2)];
  return `pcl_${encoded}`;
}

export function hashPortalOtp(otp: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}.${createHash('sha256').update(`${salt}:${otp}`).digest('hex')}`;
}

export function portalOtpMatches(stored: string, otp: string): boolean {
  const [salt, expected] = stored.split('.');
  if (!salt || !expected) return false;
  const actual = createHash('sha256').update(`${salt}:${otp}`).digest();
  const expectedBytes = Buffer.from(expected, 'hex');
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

/**
 * The only text the sign-in code message carries. It names the branch and the
 * code, never a drug, salt or medicine category (Meta policy, DRAP s.24).
 */
export function portalCodeMessage(branchName: string, otp: string): string {
  const name = branchName.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Your pharmacy';
  return `${name}: your sign-in code is ${otp}. It expires in 10 minutes. Do not share it.`;
}

/** Shows only the last four digits of the phone a code was sent to. */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : null;
}

function portalScope(session: PortalSession): LedgerScope {
  return {
    organizationId: session.organizationId,
    branchId: session.branchId,
    actorId: `portal-customer:${session.customerId}`,
  };
}

async function customerPhone(db: ScopedDb, organizationId: string, customerId: string) {
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: customerId, organizationId, active: true },
    select: { id: true, displayName: true, patient: { select: { phone: true } } },
  });
  if (!customer) throw new PharmacyPortalError('CUSTOMER_NOT_FOUND');
  const phone = normalizeWhatsAppNumber(customer.patient.phone);
  return { customer, phone };
}

/** Staff: mint a sign-in link for one customer. The code goes to the customer's stored phone. */
export async function mintPortalLink(db: ScopedDb, scope: LedgerScope, customerId: string) {
  const { phone } = await customerPhone(db, scope.organizationId, customerId);
  if (!phone) throw new PharmacyPortalError('PHONE_REQUIRED');
  const token = opaqueLinkToken();
  const link = await db.pharmacyCustomerPortalLink.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId,
      tokenHash: hashPortalSecret(token),
      createdByUserId: scope.actorId,
      expiresAt: new Date(Date.now() + PORTAL_LINK_TTL_MS),
    },
    select: { id: true, expiresAt: true },
  });
  return {
    linkId: link.id,
    expiresAt: link.expiresAt,
    // A path, not a URL: staff share it from this tenant's own host.
    path: `/my-pharmacy/join/${token}`,
  };
}

export async function resolvePortalLink(db: ScopedDb, organizationId: string, token: string) {
  if (!PORTAL_LINK_PATTERN.test(token)) return null;
  const link = await db.pharmacyCustomerPortalLink.findUnique({
    where: { tokenHash: hashPortalSecret(token) },
    select: {
      id: true,
      organizationId: true,
      branchId: true,
      customerId: true,
      expiresAt: true,
      revokedAt: true,
      otpHash: true,
      otpExpiresAt: true,
      otpFailedAttempts: true,
      branch: { select: { name: true, active: true } },
      customer: { select: { active: true, displayName: true } },
    },
  });
  if (
    !link ||
    link.organizationId !== organizationId ||
    link.revokedAt ||
    link.expiresAt <= new Date() ||
    !link.branch.active ||
    !link.customer.active
  )
    return null;
  return link;
}

/**
 * Sends a fresh code to the customer's stored phone. A new code replaces the old one;
 * the failed-guess counter carries over and clears only on a correct code. A link
 * locked by five wrong codes sends nothing more (DEV-906): staff issue a new link.
 */
export async function startPortalSignIn(
  db: ScopedDb,
  organizationId: string,
  token: string,
  sendCode: (input: { to: string; otp: string; body: string }) => Promise<unknown>
) {
  const link = await resolvePortalLink(db, organizationId, token);
  if (!link) throw new PharmacyPortalError('LINK_INVALID');
  if (link.otpFailedAttempts >= PORTAL_OTP_MAX_ATTEMPTS)
    throw new PharmacyPortalError('LINK_LOCKED');
  const { phone } = await customerPhone(db, organizationId, link.customerId);
  if (!phone) throw new PharmacyPortalError('PHONE_REQUIRED');
  const otp = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
  // The lock is re-checked in the write, so a guess that locks the link while this
  // request is in flight still stops the code from being stored or sent.
  const stored = await db.pharmacyCustomerPortalLink.updateMany({
    where: { id: link.id, otpFailedAttempts: { lt: PORTAL_OTP_MAX_ATTEMPTS } },
    data: {
      otpHash: hashPortalOtp(otp),
      otpExpiresAt: new Date(Date.now() + PORTAL_OTP_TTL_MS),
      // otpFailedAttempts is deliberately not reset: a resend must not refresh the guess limit.
    },
  });
  if (stored.count !== 1) throw new PharmacyPortalError('LINK_LOCKED');
  try {
    await sendCode({ to: phone, otp, body: portalCodeMessage(link.branch.name, otp) });
  } catch {
    throw new PharmacyPortalError('SEND_FAILED');
  }
  return { sentTo: maskPhone(phone) };
}

/**
 * Chooses how a sign-in code is sent. The configured live sender belongs to one
 * organization: another tenant's customers are never sent codes from it. Live
 * Meta delivery uses an approved authentication template, because free text
 * only reaches customers inside a 24-hour conversation window.
 */
export function portalCodeSender(
  config: Pick<WhatsAppConfig, 'provider' | 'organizationId' | 'templates'>,
  provider: Pick<WhatsAppProvider, 'sendText' | 'sendTemplate'>,
  organizationId: string
) {
  return async (input: { to: string; otp: string; body: string }) => {
    if (config.provider !== 'meta') return provider.sendText({ to: input.to, body: input.body });
    if (config.organizationId !== organizationId || !config.templates.portalSignInCode)
      throw new PharmacyPortalError('SEND_FAILED');
    return provider.sendTemplate({
      to: input.to,
      template: 'portalSignInCode',
      parameters: [input.otp],
    });
  };
}

export type PortalVerifyResult =
  { ok: true; sessionToken: string; expiresAt: Date } | { ok: false };

/**
 * Checks the code. A wrong code counts against the link; after five the link
 * stays locked, even across resends; staff must issue a new link. An expired
 * code needs a resend. A correct code is single use.
 */
export async function verifyPortalSignIn(
  db: ScopedDb,
  organizationId: string,
  token: string,
  otp: string
): Promise<PortalVerifyResult> {
  const link = await resolvePortalLink(db, organizationId, token);
  if (
    !link ||
    !/^\d{6}$/.test(otp) ||
    !link.otpHash ||
    !link.otpExpiresAt ||
    link.otpExpiresAt <= new Date() ||
    link.otpFailedAttempts >= PORTAL_OTP_MAX_ATTEMPTS
  )
    return { ok: false };
  if (!portalOtpMatches(link.otpHash, otp)) {
    await db.pharmacyCustomerPortalLink.update({
      where: { id: link.id },
      data: { otpFailedAttempts: { increment: 1 } },
    });
    return { ok: false };
  }
  // Consume the code only if it is still the one that was checked.
  const consumed = await db.pharmacyCustomerPortalLink.updateMany({
    where: { id: link.id, otpHash: link.otpHash },
    data: { otpHash: null, otpExpiresAt: null, otpFailedAttempts: 0 },
  });
  if (consumed.count !== 1) return { ok: false };
  const sessionToken = `pcs_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + PORTAL_SESSION_TTL_MS);
  await db.pharmacyCustomerPortalSession.create({
    data: {
      organizationId,
      branchId: link.branchId,
      customerId: link.customerId,
      linkId: link.id,
      tokenHash: hashPortalSecret(sessionToken),
      expiresAt,
    },
  });
  return { ok: true, sessionToken, expiresAt };
}

export async function readPortalSession(
  db: ScopedDb,
  organizationId: string,
  sessionToken: string | null | undefined
): Promise<PortalSession | null> {
  if (!sessionToken || !SESSION_PATTERN.test(sessionToken)) return null;
  const session = await db.pharmacyCustomerPortalSession.findUnique({
    where: { tokenHash: hashPortalSecret(sessionToken) },
    select: {
      id: true,
      organizationId: true,
      branchId: true,
      customerId: true,
      expiresAt: true,
      revokedAt: true,
      customer: { select: { active: true } },
      link: { select: { revokedAt: true } },
    },
  });
  if (
    !session ||
    session.organizationId !== organizationId ||
    session.revokedAt ||
    session.link.revokedAt ||
    session.expiresAt <= new Date() ||
    !session.customer.active
  )
    return null;
  return {
    sessionId: session.id,
    organizationId: session.organizationId,
    branchId: session.branchId,
    customerId: session.customerId,
  };
}

export async function signOutPortal(db: ScopedDb, session: PortalSession) {
  await db.pharmacyCustomerPortalSession.updateMany({
    where: { id: session.sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

const requestSelect = {
  id: true,
  kind: true,
  status: true,
  note: true,
  amountMinor: true,
  decisionNote: true,
  khataReceiptReference: true,
  createdAt: true,
  decidedAt: true,
  refillSale: { select: { receiptNumber: true } },
} as const;

/** Everything the signed-in customer sees: only their own records. */
export async function readPortalHome(db: ScopedDb, session: PortalSession) {
  const scope = portalScope(session);
  const [snapshot, branch, organization, accounts, templates, requests] = await Promise.all([
    readCustomerSnapshot(db, scope, session.customerId),
    db.pharmacyBranch.findFirst({
      where: { id: session.branchId, organizationId: session.organizationId },
      select: { name: true, manualPaymentSettings: true },
    }),
    db.organization.findUnique({
      where: { id: session.organizationId },
      select: { currency: true },
    }),
    db.pharmacyFamilyAccount.findMany({
      where: {
        organizationId: session.organizationId,
        branchId: session.branchId,
        payerCustomerId: session.customerId,
        active: true,
      },
      select: { id: true, displayName: true, creditLimitMinor: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.pharmacyMarketingTemplate.findMany({
      where: { organizationId: session.organizationId, branchId: session.branchId },
      select: { id: true, name: true, body: true },
      orderBy: [{ approvedAt: 'desc' }, { id: 'asc' }],
      take: 20,
    }),
    db.pharmacyCustomerPortalRequest.findMany({
      where: { organizationId: session.organizationId, customerId: session.customerId },
      select: requestSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    }),
  ]);
  const khataAccounts = await Promise.all(
    accounts.map(async (account) => ({
      ...account,
      balanceMinor: await readKhataBalance(db, scope, account.id),
    }))
  );
  const settings = manualPaymentSettingsSchema.safeParse(branch?.manualPaymentSettings ?? {});
  const raast = settings.success ? settings.data.RAAST : undefined;
  return {
    customer: { displayName: snapshot.customer.displayName },
    branchName: branch?.name ?? '',
    currency: organization?.currency ?? 'PKR',
    loyaltyPoints: snapshot.pointsBalance,
    receipts: snapshot.history,
    khataAccounts,
    raast: raast
      ? { destination: raast.destination, qrImageDataUrl: raast.qrImageDataUrl ?? null }
      : null,
    // In-app offers are owner-approved templates that pass the non-drug content policy.
    offers: templates
      .filter((template) => isNonDrugOfferCopy(template.body))
      .slice(0, 5)
      .map((template) => ({ id: template.id, title: template.name, body: template.body })),
    requests,
  };
}

export type PortalRequestInput =
  | { kind: 'REFILL'; saleId: string; note?: string }
  | { kind: 'RX_ORDER'; prescriptionFileRef: string; note?: string }
  | {
      kind: 'KHATA_PAYMENT';
      familyAccountId: string;
      amountMinor: number;
      payerReference: string;
    };

export async function createPortalRequest(
  db: ScopedDb,
  session: PortalSession,
  input: PortalRequestInput
) {
  const base = {
    organizationId: session.organizationId,
    branchId: session.branchId,
    customerId: session.customerId,
    kind: input.kind,
  };
  if (input.kind === 'REFILL') {
    // Only one of the customer's own completed receipts at this branch can be refilled.
    const sale = await db.pharmacySale.findFirst({
      where: {
        id: input.saleId,
        organizationId: session.organizationId,
        branchId: session.branchId,
        customerId: session.customerId,
        status: 'COMPLETED',
      },
      select: { id: true },
    });
    if (!sale) throw new PharmacyPortalError('SALE_NOT_FOUND');
    return db.pharmacyCustomerPortalRequest.create({
      data: { ...base, refillSaleId: sale.id, note: input.note?.trim() || null },
      select: requestSelect,
    });
  }
  if (input.kind === 'RX_ORDER') {
    return db.pharmacyCustomerPortalRequest.create({
      data: {
        ...base,
        prescriptionFileRef: input.prescriptionFileRef,
        note: input.note?.trim() || null,
      },
      select: requestSelect,
    });
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new PharmacyPortalError('INVALID_STATE');
  const [account, branch] = await Promise.all([
    db.pharmacyFamilyAccount.findFirst({
      where: {
        id: input.familyAccountId,
        organizationId: session.organizationId,
        branchId: session.branchId,
        payerCustomerId: session.customerId,
        active: true,
      },
      select: { id: true },
    }),
    db.pharmacyBranch.findFirst({
      where: { id: session.branchId, organizationId: session.organizationId },
      select: { manualPaymentSettings: true },
    }),
  ]);
  if (!account) throw new PharmacyPortalError('ACCOUNT_NOT_FOUND');
  const settings = manualPaymentSettingsSchema.safeParse(branch?.manualPaymentSettings ?? {});
  if (!settings.success || !settings.data.RAAST)
    throw new PharmacyPortalError('RAAST_NOT_CONFIGURED');
  return db.pharmacyCustomerPortalRequest.create({
    data: {
      ...base,
      familyAccountId: account.id,
      amountMinor: input.amountMinor,
      payerReference: input.payerReference,
    },
    select: requestSelect,
  });
}

export async function cancelPortalRequest(db: ScopedDb, session: PortalSession, requestId: string) {
  const updated = await db.pharmacyCustomerPortalRequest.updateMany({
    where: {
      id: requestId,
      organizationId: session.organizationId,
      customerId: session.customerId,
      status: 'PENDING',
    },
    data: { status: 'CANCELLED' },
  });
  if (updated.count !== 1) throw new PharmacyPortalError('REQUEST_NOT_FOUND');
}

/** Staff: the branch's open customer requests, oldest first. */
export async function listPortalQueue(db: ScopedDb, scope: LedgerScope) {
  return db.pharmacyCustomerPortalRequest.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, status: 'PENDING' },
    select: {
      id: true,
      kind: true,
      note: true,
      prescriptionFileRef: true,
      amountMinor: true,
      payerReference: true,
      createdAt: true,
      customer: { select: { id: true, displayName: true, phoneLast4: true } },
      refillSale: { select: { id: true, receiptNumber: true } },
      familyAccount: { select: { id: true, displayName: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
}

async function pendingRequest(db: ScopedDb, scope: LedgerScope, requestId: string) {
  const request = await db.pharmacyCustomerPortalRequest.findFirst({
    where: { id: requestId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: {
      id: true,
      kind: true,
      status: true,
      familyAccountId: true,
      amountMinor: true,
      payerReference: true,
    },
  });
  if (!request) throw new PharmacyPortalError('REQUEST_NOT_FOUND');
  if (request.status !== 'PENDING') throw new PharmacyPortalError('INVALID_STATE');
  return request as typeof request & { kind: PortalRequestKind };
}

async function closeRequest(
  db: ScopedDb,
  scope: LedgerScope,
  requestId: string,
  data: { status: 'VERIFIED' | 'REJECTED'; decisionNote?: string; khataReceiptReference?: string }
) {
  const updated = await db.pharmacyCustomerPortalRequest.updateMany({
    where: {
      id: requestId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'PENDING',
    },
    data: {
      ...data,
      decisionNote: data.decisionNote?.trim() || null,
      decidedByUserId: scope.actorId,
      decidedAt: new Date(),
    },
  });
  if (updated.count !== 1) throw new PharmacyPortalError('INVALID_STATE');
}

/**
 * Staff decision on a refill or prescription-photo order. `allowedKinds` comes
 * from the caller's permissions: refills and prescription orders need the
 * pharmacist dispensing permission. A khata payment is never "verified" here:
 * it is confirmed only by posting it to the ledger.
 */
export async function decidePortalRequest(
  db: ScopedDb,
  scope: LedgerScope,
  input: { requestId: string; decision: 'VERIFY' | 'REJECT'; note?: string },
  allowedKinds: readonly PortalRequestKind[]
) {
  const request = await pendingRequest(db, scope, input.requestId);
  if (!allowedKinds.includes(request.kind)) throw new PharmacyPortalError('KIND_NOT_ALLOWED');
  if (input.decision === 'VERIFY' && request.kind === 'KHATA_PAYMENT')
    throw new PharmacyPortalError('KIND_NOT_ALLOWED');
  await closeRequest(db, scope, request.id, {
    status: input.decision === 'VERIFY' ? 'VERIFIED' : 'REJECTED',
    decisionNote: input.note,
  });
  return { id: request.id, kind: request.kind };
}

/**
 * Staff confirm a customer's Raast khata payment once it shows in the merchant
 * account: the payment is posted through the counter repayment path (day open,
 * ledger, bookkeeping) and the request closes with the slip reference.
 */
export async function confirmPortalKhataPayment(
  db: ScopedDb,
  scope: LedgerScope,
  input: { requestId: string; businessDate?: Date },
  now: Date = new Date()
) {
  const request = await pendingRequest(db, scope, input.requestId);
  // Money confirmed now books on today in the workspace zone (DEV-630), never on a
  // past or future day the client chose. Without a client date the server uses today.
  let businessDate = input.businessDate;
  if (!businessDate) {
    // DEV-958A: today on the branch's clock, whose day ends at its "day ends at" hour.
    businessDate = await currentPharmacyBusinessDate(db, scope, now);
  }
  await requireCurrentPharmacyBusinessDate(db, scope, businessDate, now);
  if (
    request.kind !== 'KHATA_PAYMENT' ||
    !request.familyAccountId ||
    !request.amountMinor ||
    !request.payerReference
  )
    throw new PharmacyPortalError('KIND_NOT_ALLOWED');
  const slip = await recordKhataRepayment(db, scope, {
    familyAccountId: request.familyAccountId,
    amountMinor: request.amountMinor,
    tender: 'RAAST',
    payerReference: request.payerReference,
    businessDate,
    idempotencyKey: `portal-request:${request.id}`,
  });
  await closeRequest(db, scope, request.id, {
    status: 'VERIFIED',
    khataReceiptReference: slip.receiptReference,
  });
  return slip;
}
