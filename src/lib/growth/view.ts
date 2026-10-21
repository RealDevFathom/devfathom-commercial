/** View shapes for the growth admin. Field names follow the WP-G1 models, with organizationId as the tenant key. */

export const CAMPAIGN_KINDS = [
  'holiday',
  'slow_day',
  'birthday',
  'refill',
  'winback',
  'random',
  'manual',
  'review',
  'referral',
] as const;

export const CAMPAIGN_STATUSES = [
  'proposed',
  'approved',
  'scheduled',
  'sending',
  'sent',
  'cancelled',
  'exhausted',
] as const;

export const TEMPLATE_KEYS = [
  'birthday_offer',
  'refill_reminder',
  'winback',
  'slow_day',
  'holiday',
  'review_request',
  'referral',
  'generic',
] as const;

export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export type GrowthTab = 'proposed' | 'scheduled' | 'sent' | 'all';

export type GrowthSegment =
  | { type: 'all' }
  | { type: 'churn_band'; band: 'low' | 'medium' | 'high' | 'lost' }
  | { type: 'birthday'; month: number; dayWindow?: number }
  | { type: 'refill_due'; withinDays: number }
  | { type: 'random'; pct: number; seed?: number }
  | { type: 'top_spenders'; n: number }
  | { type: 'inactive_days'; min: number; max: number };

export type GrowthCampaign = {
  id: string;
  organizationId: string;
  kind: CampaignKind;
  status: CampaignStatus;
  name: string;
  rationale: string | null;
  segment: GrowthSegment;
  sendAt: string;
  discountType: 'percent' | 'fixed' | 'none';
  discountValue: number | null;
  codeExpiresAt: string | null;
  budgetCapMinor: number;
  spentMinor: number;
  templateId: string;
  estimatedReach: number;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  redemptionCount: number;
};

export type GrowthRecipient = {
  id: string;
  campaignId: string;
  customerId: string;
  name: string;
  phoneMasked: string;
  code: string | null;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped' | 'redeemed';
  sentAt: string | null;
  redeemedAt: string | null;
  saleId: string | null;
  error: string | null;
};

export type GrowthTemplate = {
  id: string;
  key: TemplateKey;
  language: string;
  body: string;
};

export type GrowthMessage = {
  id: string;
  customerId: string | null;
  direction: 'out' | 'in';
  body: string;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';
  campaignId: string | null;
  error: string | null;
  createdAt: string;
};

export type GrowthSettingsView = {
  monthlyBudgetMinor: number;
  autoApproveUnderMinor: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  maxMsgsPerDay: number;
  maxDiscountPct: number;
  customDates: string[];
  waInstanceName: string | null;
  waApiUrl: string | null;
  waApiKeyHint: string | null;
};

export type GrowthSummary = {
  optedInCustomers: number;
  highChurnCustomers: number;
  monthSpendMinor: number;
  monthlyBudgetMinor: number;
  redemptionsThisMonth: number;
};

export type GrowthConnection = {
  status: 'connected' | 'needs_pairing';
  managerUrl: string | null;
};

export function campaignInTab(status: CampaignStatus, tab: GrowthTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'proposed') return status === 'proposed';
  if (tab === 'scheduled')
    return status === 'approved' || status === 'scheduled' || status === 'sending';
  return status === 'sent' || status === 'exhausted';
}
