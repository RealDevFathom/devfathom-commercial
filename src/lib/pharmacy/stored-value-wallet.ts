import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { can, type Subject } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import { assertMinor } from '@/lib/stored-value/accounts';

export const DEFAULT_WALLET_TIERS = [
  { name: 'Bronze', qualifyingTopUpMinor: 2_000_000, discountBps: 200 },
  { name: 'Silver', qualifyingTopUpMinor: 5_000_000, discountBps: 500 },
  { name: 'Gold', qualifyingTopUpMinor: 10_000_000, discountBps: 1_000 },
] as const;

export type WalletTier = { name: string; qualifyingTopUpMinor: number; discountBps: number };

/** A top-up chooses the highest threshold it independently qualifies for. */
export function selectWalletTier(topUpMinor: number, tiers: readonly WalletTier[]): WalletTier | null {
  assertMinor(topUpMinor);
  return [...tiers]
    .filter((tier) => tier.qualifyingTopUpMinor <= topUpMinor)
    .sort((a, b) => b.qualifyingTopUpMinor - a.qualifyingTopUpMinor)[0] ?? null;
}

/**
 * Discount is limited to goods actually funded by stored value. If the balance
 * runs out, the other tender pays the undiscounted remainder.
 */
export function priceWalletPortion(basketMinor: number, balanceMinor: number, discountBps: number) {
  assertMinor(basketMinor);
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor < 0 || discountBps < 0 || discountBps > 10_000)
    throw new RangeError('INVALID_WALLET_PRICING_INPUT');
  const denominator = 10_000 - discountBps;
  if (denominator === 0) return { walletDebitMinor: 0, discountMinor: basketMinor, remainderMinor: 0 };
  const fullDiscountedMinor = Math.ceil((basketMinor * denominator) / 10_000);
  const walletDebitMinor = Math.min(balanceMinor, fullDiscountedMinor);
  const fundedGrossMinor = Math.min(basketMinor, Math.floor((walletDebitMinor * 10_000) / denominator));
  return {
    walletDebitMinor,
    discountMinor: fundedGrossMinor - walletDebitMinor,
    remainderMinor: basketMinor - fundedGrossMinor,
  };
}

export function chooseBenefits(input: {
  walletDiscountMinor: number; voucherDiscountMinor: number; pointsDiscountMinor: number; allowStacking: boolean;
}) {
  const benefits = [
    { kind: 'WALLET' as const, amountMinor: input.walletDiscountMinor },
    { kind: 'VOUCHER' as const, amountMinor: input.voucherDiscountMinor },
    { kind: 'POINTS' as const, amountMinor: input.pointsDiscountMinor },
  ];
  if (input.allowStacking) return { applied: benefits.filter((b) => b.amountMinor > 0), totalMinor: benefits.reduce((s, b) => s + b.amountMinor, 0) };
  const best = benefits.sort((a, b) => b.amountMinor - a.amountMinor)[0];
  return { applied: best.amountMinor > 0 ? [best] : [], totalMinor: best.amountMinor };
}

export function normalizeCnic(value: string): string {
  const normalized = value.replace(/[^0-9]/g, '');
  if (normalized.length !== 13) throw new RangeError('INVALID_CNIC');
  return normalized;
}

/** Persist this digest or the final four digits, never the normalized CNIC itself. */
export function cnicHmac(value: string, secret: string): string {
  if (!secret) throw new RangeError('CNIC_HMAC_SECRET_REQUIRED');
  return createHmac('sha256', secret).update(normalizeCnic(value)).digest('hex');
}

export function cnicLast4(value: string): string { return normalizeCnic(value).slice(-4); }

export function matchesCnicLast4(candidate: string, storedLast4: string): boolean {
  if (!/^\d{4}$/.test(candidate) || !/^\d{4}$/.test(storedLast4)) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(storedLast4));
}

export interface WalletOtpVerifier {
  verify(input: { organizationId: string; customerId: string; challenge: string }): Promise<boolean>;
}
export const disabledWalletOtpVerifier: WalletOtpVerifier = { async verify() { throw new Error('WALLET_OTP_NOT_CONFIGURED'); } };

export async function requireWalletCapability(input: {
  subject: Subject; db: AuthzDb; operation: 'TOP_UP' | 'ADJUSTMENT'; reason?: string;
}) {
  if (input.operation === 'ADJUSTMENT' && !input.reason?.trim()) throw new Error('ADJUSTMENT_REASON_REQUIRED');
  const capability = input.operation === 'TOP_UP' ? 'pharmacy:wallet-topup' : 'pharmacy:wallet-adjust';
  if (!(await can(input.subject, capability, undefined, { db: input.db }))) throw new Error('FORBIDDEN');
}

export function isCnicLocked(input: { customerFailures: number; cashierFailures: number; limit: number }) {
  return input.customerFailures >= input.limit || input.cashierFailures >= input.limit;
}

export function assertTopUpRefundAllowed(input: {
  allowUnusedRefund: boolean; requestedMinor: number; unusedMinor: number; originalTender: string;
}) {
  assertMinor(input.requestedMinor);
  if (!input.allowUnusedRefund) throw new Error('TOP_UP_REFUND_DISABLED');
  if (input.requestedMinor > input.unusedMinor) throw new Error('TOP_UP_ALREADY_USED');
  return { amountMinor: input.requestedMinor, tender: input.originalTender };
}

export function expiryIdempotencyKey(accountId: string, expiresOn: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new RangeError('INVALID_EXPIRY_DATE');
  return `wallet:expiry:${accountId}:${expiresOn}`;
}

export type CnicFailureStore = {
  counts(input: { organizationId: string; customerId: string; cashierId: string; since: Date }): Promise<{ customer: number; cashier: number }>;
  record(input: { organizationId: string; customerId: string; cashierId: string; action: 'CNIC_MATCH_FAILED' }): Promise<void>;
};

/** Counter verification happens after phone lookup and physical card inspection. */
export async function verifyWalletRedemptionIdentity(input: {
  organizationId: string; customerId: string; cashierId: string; enteredLast4: string; storedLast4: string;
  limit: number; lockoutMinutes: number; now: Date; store: CnicFailureStore;
}) {
  const since = new Date(input.now.getTime() - input.lockoutMinutes * 60_000);
  const failures = await input.store.counts({ organizationId: input.organizationId, customerId: input.customerId, cashierId: input.cashierId, since });
  if (isCnicLocked({ customerFailures: failures.customer, cashierFailures: failures.cashier, limit: input.limit })) throw new Error('CNIC_MATCH_LOCKED');
  if (!matchesCnicLast4(input.enteredLast4, input.storedLast4)) {
    // The audit deliberately contains identifiers and outcome only, never either CNIC value.
    await input.store.record({ organizationId: input.organizationId, customerId: input.customerId, cashierId: input.cashierId, action: 'CNIC_MATCH_FAILED' });
    throw new Error('CNIC_MISMATCH');
  }
  return true;
}
