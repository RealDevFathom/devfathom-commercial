import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Customer portal policy primitives. Clinical details must never enter outbound chat copy. */
export type CustomerOtpChannel = 'SMS' | 'WHATSAPP';
export type RxRequestStatus = 'AWAITING_PHARMACIST' | 'APPROVED' | 'DECLINED' | 'FULFILLED';

export type CustomerPortalConfig = {
  otpTtlMinutes: number;
  otpMaxAttempts: number;
  loyaltyLabel: string;
  raastPayeeLabel: string;
  nonDrugOffersEnabled: boolean;
};

export const DEFAULT_CUSTOMER_PORTAL_CONFIG: CustomerPortalConfig = {
  otpTtlMinutes: 10,
  otpMaxAttempts: 5,
  loyaltyLabel: 'Loyalty points',
  raastPayeeLabel: 'Store account',
  nonDrugOffersEnabled: true,
};

export function validateCustomerPortalConfig(value: CustomerPortalConfig) {
  if (!Number.isInteger(value.otpTtlMinutes) || value.otpTtlMinutes < 1 || value.otpTtlMinutes > 30)
    throw new Error('OTP_TTL_OUT_OF_RANGE');
  if (
    !Number.isInteger(value.otpMaxAttempts) ||
    value.otpMaxAttempts < 1 ||
    value.otpMaxAttempts > 10
  )
    throw new Error('OTP_ATTEMPTS_OUT_OF_RANGE');
  if (!value.loyaltyLabel.trim() || !value.raastPayeeLabel.trim())
    throw new Error('LABEL_REQUIRED');
  return value;
}

export function createCustomerOtp(
  customerId: string,
  organizationId: string,
  now = new Date(),
  ttlMinutes = 10
) {
  const code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
  const salt = randomBytes(16).toString('hex');
  return {
    code,
    challenge: {
      customerId,
      organizationId,
      digest: otpDigest(code, salt, customerId, organizationId),
      salt,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
      attempts: 0,
    },
  };
}

function otpDigest(code: string, salt: string, customerId: string, organizationId: string) {
  return createHash('sha256').update(`${salt}:${organizationId}:${customerId}:${code}`).digest();
}

export function verifyCustomerOtp(
  challenge: ReturnType<typeof createCustomerOtp>['challenge'],
  input: { code: string; customerId: string; organizationId: string },
  now = new Date(),
  maxAttempts = 5
) {
  if (
    challenge.customerId !== input.customerId ||
    challenge.organizationId !== input.organizationId
  )
    return { ok: false as const, reason: 'SCOPE_MISMATCH' as const };
  if (now >= challenge.expiresAt) return { ok: false as const, reason: 'EXPIRED' as const };
  if (challenge.attempts >= maxAttempts) return { ok: false as const, reason: 'LOCKED' as const };
  challenge.attempts += 1;
  if (!/^\d{6}$/.test(input.code)) return { ok: false as const, reason: 'INVALID' as const };
  const actual = otpDigest(input.code, challenge.salt, input.customerId, input.organizationId);
  return timingSafeEqual(actual, challenge.digest)
    ? {
        ok: true as const,
        customerId: challenge.customerId,
        organizationId: challenge.organizationId,
      }
    : { ok: false as const, reason: 'INVALID' as const };
}

/** Only transactional, content-free copy is permitted on WhatsApp (Meta/DRAP safe). */
export function customerWhatsAppText(
  kind: 'OTP' | 'REFILL' | 'RX_UPDATE' | 'RECEIPT',
  value?: string
) {
  switch (kind) {
    case 'OTP':
      return `Your DevFathom verification code is ${value ?? ''}. It expires soon. Do not share it.`;
    case 'REFILL':
      return 'Your refill request was received. A pharmacist will review it before fulfilment.';
    case 'RX_UPDATE':
      return 'Your order request has an update. Open your secure customer link to review it.';
    case 'RECEIPT':
      return 'Your receipt is ready. Open your secure customer link to view it.';
  }
}

export function transitionRxRequest(
  status: RxRequestStatus,
  action: 'APPROVE' | 'DECLINE' | 'FULFIL'
) {
  if (status === 'AWAITING_PHARMACIST' && action === 'APPROVE') return 'APPROVED' as const;
  if (status === 'AWAITING_PHARMACIST' && action === 'DECLINE') return 'DECLINED' as const;
  if (status === 'APPROVED' && action === 'FULFIL') return 'FULFILLED' as const;
  throw new Error('PHARMACIST_VERIFICATION_REQUIRED');
}

export function visibleCustomerOffers<T extends { kind: 'NON_DRUG' | 'DRUG'; active: boolean }>(
  offers: T[],
  enabled: boolean
) {
  return enabled ? offers.filter((offer) => offer.active && offer.kind === 'NON_DRUG') : [];
}
