import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { can, type Subject } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';

import { issueVoucher, type VoucherStore } from './loyalty-vouchers';

const DAY_MS = 86_400_000;
const BASIS_POINTS = 10_000;
/** PostgreSQL INTEGER upper bound; all persisted money uses integer minor units. */
export const MAX_MONEY_MINOR = 2_147_483_647;

export type WinBackTier = {
  minimumSpendMinor: number;
  maximumSpendMinor: number | null;
  voucherValueMinor: number;
};

/** Default editable bands: Rs 200, Rs 500, and Rs 1,000 (all stored in paisa). */
export const DEFAULT_WIN_BACK_TIERS: readonly WinBackTier[] = [
  { minimumSpendMinor: 0, maximumSpendMinor: 99_999, voucherValueMinor: 20_000 },
  { minimumSpendMinor: 100_000, maximumSpendMinor: 499_999, voucherValueMinor: 50_000 },
  { minimumSpendMinor: 500_000, maximumSpendMinor: null, voucherValueMinor: 100_000 },
];

export type WinBackRules = {
  inactivityDays: number;
  windowDays: number;
  minimumSpendMinor: number;
  minNextBasketMinor: number;
  defaultMarginBasisPoints: number;
  redemptionBasisPoints: number;
  tiers: readonly WinBackTier[];
  categoryMargins: Readonly<Record<string, number>>;
};

export type WinBackCustomer = {
  customerId: string;
  branchId: string;
  phone: string | null;
  lastSaleAt: Date;
  /** Sum of completed PharmacySale net paid amounts; never loyalty points. */
  pastSpendMinor: number;
  expectedBasketMinor: number;
  primaryCategoryId: string | null;
  active: boolean;
  whatsappOptIn: boolean | null;
  loyaltyConsentGranted: boolean;
};

export class WinBackError extends Error {
  constructor(readonly reason: 'FORBIDDEN' | 'INVALID_RULES' | 'INVALID_CANDIDATE' | 'PREVIEW_REQUIRED') {
    super(reason);
  }
}

function integerInRange(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function validateWinBackRules(rules: WinBackRules): void {
  if (
    !integerInRange(rules.inactivityDays, 1, 3650) ||
    !integerInRange(rules.windowDays, 1, 365) ||
    !integerInRange(rules.minimumSpendMinor, 0, MAX_MONEY_MINOR) ||
    !integerInRange(rules.minNextBasketMinor, 0, MAX_MONEY_MINOR) ||
    !integerInRange(rules.defaultMarginBasisPoints, 0, BASIS_POINTS) ||
    !integerInRange(rules.redemptionBasisPoints, 0, BASIS_POINTS) ||
    rules.tiers.length === 0
  ) throw new WinBackError('INVALID_RULES');

  let previousMaximum = -1;
  for (const tier of [...rules.tiers].sort((a, b) => a.minimumSpendMinor - b.minimumSpendMinor)) {
    if (!integerInRange(tier.minimumSpendMinor, 0, MAX_MONEY_MINOR) ||
        (tier.maximumSpendMinor !== null && (!integerInRange(tier.maximumSpendMinor, tier.minimumSpendMinor, MAX_MONEY_MINOR))) ||
        !integerInRange(tier.voucherValueMinor, 20_000, 100_000) || tier.minimumSpendMinor <= previousMaximum)
      throw new WinBackError('INVALID_RULES');
    previousMaximum = tier.maximumSpendMinor ?? MAX_MONEY_MINOR;
  }
  if (Object.values(rules.categoryMargins).some((margin) => !integerInRange(margin, 0, BASIS_POINTS)))
    throw new WinBackError('INVALID_RULES');
}

export function tierForSpend(tiers: readonly WinBackTier[], pastSpendMinor: number) {
  if (!Number.isSafeInteger(pastSpendMinor) || pastSpendMinor < 0) throw new RangeError('INVALID_MONEY');
  return [...tiers]
    .sort((a, b) => b.minimumSpendMinor - a.minimumSpendMinor)
    .find((tier) => pastSpendMinor >= tier.minimumSpendMinor &&
      (tier.maximumSpendMinor === null || pastSpendMinor <= tier.maximumSpendMinor)) ?? null;
}

/** Eligibility is evaluated at the supplied job/preview instant, never wall-clock time. */
export function selectWinBackCustomers(
  customers: readonly WinBackCustomer[], rules: WinBackRules, at: Date
) {
  validateWinBackRules(rules);
  const inactiveBefore = at.getTime() - rules.inactivityDays * DAY_MS;
  return customers.flatMap((customer) => {
    if (!customer.customerId || !customer.branchId ||
        !integerInRange(customer.pastSpendMinor, 0, MAX_MONEY_MINOR) ||
        !integerInRange(customer.expectedBasketMinor, 0, MAX_MONEY_MINOR) ||
        !Number.isFinite(customer.lastSaleAt.getTime())) throw new WinBackError('INVALID_CANDIDATE');
    const tier = tierForSpend(rules.tiers, customer.pastSpendMinor);
    return customer.active && customer.whatsappOptIn === true && customer.loyaltyConsentGranted &&
      customer.lastSaleAt.getTime() <= inactiveBefore && customer.pastSpendMinor >= rules.minimumSpendMinor && tier
      ? [{ ...customer, tier }]
      : [];
  });
}

function canonicalRules(rules: WinBackRules) {
  return JSON.stringify({
    ...rules,
    tiers: [...rules.tiers].sort((a, b) => a.minimumSpendMinor - b.minimumSpendMinor),
    categoryMargins: Object.fromEntries(Object.entries(rules.categoryMargins).sort(([a], [b]) => a.localeCompare(b))),
  });
}

export function winBackRulesHash(rules: WinBackRules) {
  validateWinBackRules(rules);
  return createHash('sha256').update(canonicalRules(rules)).digest('hex');
}

/**
 * Preview assumption: `redemptionBasisPoints` of eligible customers redeem once,
 * and their expected basket earns the configured category (or 14.5% default) margin.
 * Multiplication precedes integer division, so every result remains integer paisa.
 */
export function calculateWinBackPreview(
  customers: readonly WinBackCustomer[], rules: WinBackRules, at: Date
) {
  const eligible = selectWinBackCustomers(customers, rules, at);
  const totalVoucherLiabilityMinor = eligible.reduce((sum, row) => {
    const total = sum + row.tier.voucherValueMinor;
    if (!integerInRange(total, 0, MAX_MONEY_MINOR)) throw new WinBackError('INVALID_CANDIDATE');
    return total;
  }, 0);
  if (!integerInRange(eligible.length, 0, MAX_MONEY_MINOR)) throw new WinBackError('INVALID_CANDIDATE');
  const expectedRedemptions = Math.floor(eligible.length * rules.redemptionBasisPoints / BASIS_POINTS);
  const expectedVoucherCostMinor = Math.floor(totalVoucherLiabilityMinor * rules.redemptionBasisPoints / BASIS_POINTS);
  const expectedMarginMinor = eligible.reduce((sum, row) => {
    const margin = row.primaryCategoryId === null
      ? rules.defaultMarginBasisPoints
      : (rules.categoryMargins[row.primaryCategoryId] ?? rules.defaultMarginBasisPoints);
    const contribution = Math.floor(row.expectedBasketMinor * margin * rules.redemptionBasisPoints /
      (BASIS_POINTS * BASIS_POINTS));
    const total = sum + contribution;
    if (!integerInRange(total, 0, MAX_MONEY_MINOR)) throw new WinBackError('INVALID_CANDIDATE');
    return total;
  }, 0);
  const netMarginImpactMinor = expectedMarginMinor - expectedVoucherCostMinor;
  if (!integerInRange(netMarginImpactMinor, -MAX_MONEY_MINOR, MAX_MONEY_MINOR))
    throw new WinBackError('INVALID_CANDIDATE');
  return {
    settingsHash: winBackRulesHash(rules), eligibleCustomerCount: eligible.length,
    totalVoucherLiabilityMinor, expectedRedemptions, expectedVoucherCostMinor, expectedMarginMinor,
    netMarginImpactMinor,
    redemptionBasisPoints: rules.redemptionBasisPoints,
  };
}

type OwnerStore = {
  authorizationDb: AuthzDb;
  saveRulesAndAudit(input: { organizationId: string; actorId: string; oldValue: WinBackRules; newValue: WinBackRules }): Promise<void>;
  readRules(organizationId: string): Promise<WinBackRules>;
  readCandidates(organizationId: string, at: Date): Promise<WinBackCustomer[]>;
  savePreview(input: ReturnType<typeof calculateWinBackPreview> & { id: string; organizationId: string; actorId: string; generatedAt: Date }): Promise<void>;
  /** Lock settings + preview and enable only when their hashes still match. */
  enableAndAuditIfPreviewCurrent(input: { organizationId: string; actorId: string; previewId: string;
    expectedSettingsHash: string }): Promise<boolean>;
};

async function requireOwner(store: OwnerStore, subject: Subject, at: Date) {
  if (!(await can(subject, 'pharmacy:loyalty-manage', undefined, { db: store.authorizationDb, now: at })))
    throw new WinBackError('FORBIDDEN');
}

export async function changeWinBackRules(store: OwnerStore, input: {
  organizationId: string; subject: Subject; rules: WinBackRules; now?: Date;
}) {
  const now = input.now ?? new Date();
  await requireOwner(store, input.subject, now);
  validateWinBackRules(input.rules);
  const oldValue = await store.readRules(input.organizationId);
  await store.saveRulesAndAudit({ organizationId: input.organizationId, actorId: input.subject.id,
    oldValue, newValue: input.rules });
}

export async function generateWinBackPreview(store: OwnerStore, input: {
  organizationId: string; subject: Subject; now?: Date;
}) {
  const generatedAt = input.now ?? new Date();
  await requireOwner(store, input.subject, generatedAt);
  const rules = await store.readRules(input.organizationId);
  const preview = calculateWinBackPreview(await store.readCandidates(input.organizationId, generatedAt), rules, generatedAt);
  const id = randomUUID();
  await store.savePreview({ ...preview, id, organizationId: input.organizationId,
    actorId: input.subject.id, generatedAt });
  return { id, ...preview };
}

export async function enableWinBack(store: OwnerStore, input: {
  organizationId: string; subject: Subject; previewId: string; now?: Date;
}) {
  const now = input.now ?? new Date();
  await requireOwner(store, input.subject, now);
  const rules = await store.readRules(input.organizationId);
  const expectedSettingsHash = winBackRulesHash(rules);
  const enabled = await store.enableAndAuditIfPreviewCurrent({ organizationId: input.organizationId,
    actorId: input.subject.id, previewId: input.previewId, expectedSettingsHash });
  if (!enabled) throw new WinBackError('PREVIEW_REQUIRED');
}

export type WinBackCampaign = {
  organizationId: string; rules: WinBackRules; enabledPreviewId: string | null;
  enabledPreviewHash: string | null;
};

export type WinBackJobStore = {
  listEnabledCampaigns(): Promise<WinBackCampaign[]>;
  authorizationDb(organizationId: string): AuthzDb;
  readCandidates(organizationId: string, at: Date): Promise<WinBackCustomer[]>;
  /** Adapter opens one tenant transaction and locks the candidate before returning it. */
  transaction<T>(organizationId: string, operation: (tx: {
    vouchers: VoucherStore;
    lockCandidate(input: { customerId: string; branchId: string }): Promise<WinBackCustomer | null>;
    claimIssuance(input: { customerId: string; branchId: string; campaignWindowStart: Date }): Promise<boolean>;
    attachVoucher(input: { customerId: string; branchId: string; campaignWindowStart: Date; voucherId: string }): Promise<void>;
    enqueueTransactionalMessage(input: { customerId: string; branchId: string; voucherId: string; dedupeKey: string }): Promise<void>;
  }) => Promise<T>): Promise<T>;
};

export async function processWinBackCampaigns(store: WinBackJobStore, input: { subject: Subject; now?: Date }) {
  const now = input.now ?? new Date();
  let issued = 0; let duplicates = 0; let skipped = 0;
  for (const campaign of await store.listEnabledCampaigns()) {
    if (!(await can(input.subject, 'pharmacy:loyalty-manage', undefined, {
      db: store.authorizationDb(campaign.organizationId), now, source: 'SYSTEM',
    }))) throw new WinBackError('FORBIDDEN');
    if (!campaign.enabledPreviewId || campaign.enabledPreviewHash !== winBackRulesHash(campaign.rules)) {
      skipped += 1; continue;
    }
    const windowMs = campaign.rules.windowDays * DAY_MS;
    const campaignWindowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const candidates = selectWinBackCustomers(
      await store.readCandidates(campaign.organizationId, now), campaign.rules, now
    );
    for (const candidate of candidates) {
      const didIssue = await store.transaction(campaign.organizationId, async (tx) => {
        const current = await tx.lockCandidate({ customerId: candidate.customerId, branchId: candidate.branchId });
        if (!current || current.branchId !== candidate.branchId) return false;
        const [eligible] = selectWinBackCustomers([current], campaign.rules, now);
        if (!eligible || !(await tx.claimIssuance({ customerId: current.customerId,
          branchId: current.branchId, campaignWindowStart }))) return false;
        const voucher = await issueVoucher(tx.vouchers, {
          organizationId: campaign.organizationId, branchId: current.branchId,
          customerId: current.customerId, phone: current.phone,
          valueMinor: eligible.tier.voucherValueMinor,
          minNextBasketMinor: campaign.rules.minNextBasketMinor, actorId: 'SYSTEM_WIN_BACK', issuedAt: now,
        });
        await tx.attachVoucher({ customerId: current.customerId, branchId: current.branchId,
          campaignWindowStart, voucherId: voucher.id });
        await tx.enqueueTransactionalMessage({ customerId: current.customerId, branchId: current.branchId,
          voucherId: voucher.id,
          dedupeKey: `win-back:${current.branchId}:${current.customerId}:${campaignWindowStart.toISOString()}` });
        return true;
      });
      if (didIssue) issued += 1; else duplicates += 1;
    }
  }
  return { issued, duplicates, skipped };
}
