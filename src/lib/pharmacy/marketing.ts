export const MARKETING_SEGMENT_FIELDS = [
  'daysSinceLastReceipt',
  'receiptCount',
  'otcOnly',
  'restockInterest',
  'frontShopMarginMinor',
  'familyAccount',
] as const;

export type MarketingSegmentField = (typeof MARKETING_SEGMENT_FIELDS)[number];
export type SegmentDefinition = {
  version: 1;
  all: Array<{ field: string; operator: 'eq' | 'gte' | 'lte'; value: boolean | number }>;
};

const forbiddenClinicalKey = /prescription|condition|allerg|medicine|diagnos|patient|drug|rx/i;

export function validateSegmentDefinition(input: unknown): asserts input is SegmentDefinition {
  if (!input || typeof input !== 'object') throw new Error('A segment definition is required.');
  const definition = input as { version?: unknown; all?: unknown };
  if (definition.version !== 1 || !Array.isArray(definition.all) || definition.all.length === 0)
    throw new Error('The segment definition must contain at least one supported rule.');
  for (const rule of definition.all) {
    if (!rule || typeof rule !== 'object') throw new Error('Every segment rule must be an object.');
    const candidate = rule as Record<string, unknown>;
    if (
      Object.keys(candidate).some((key) => forbiddenClinicalKey.test(key)) ||
      (typeof candidate.field === 'string' && forbiddenClinicalKey.test(candidate.field))
    )
      throw new Error('Clinical and medicine data cannot be used in marketing segments.');
    if (!MARKETING_SEGMENT_FIELDS.includes(candidate.field as MarketingSegmentField))
      throw new Error(`Unsupported marketing segment field: ${String(candidate.field)}.`);
    if (!['eq', 'gte', 'lte'].includes(String(candidate.operator)))
      throw new Error('Unsupported marketing segment operator.');
    if (!['boolean', 'number'].includes(typeof candidate.value))
      throw new Error('Marketing segment values must be boolean or numeric.');
  }
}

type CaptureCandidate = {
  customerId: string;
  consent?: { granted: boolean; effectiveAt: Date };
  priorCaptures: Date[];
};

type CapturePlanInput = {
  campaignId: string;
  channel: 'SMS' | 'WHATSAPP' | 'EMAIL';
  purpose: 'MARKETING';
  template: { approved: boolean; body: string };
  ownerApproval: { approved: boolean };
  regulatoryApproval: { d10Approved: boolean };
  promotesRegulatedItem: boolean;
  candidates: CaptureCandidate[];
  now: Date;
  quietHours: { startHour: number; endHour: number };
  frequencyCap: { max: number; windowDays: number };
};

export type CaptureExclusionReason = 'OPTED_OUT' | 'NO_CONSENT' | 'FREQUENCY_CAP';

export function assertNonClinicalMarketingBody(body: string) {
  if (forbiddenClinicalKey.test(body))
    throw new Error('Clinical and medicine data cannot appear in marketing messages.');
}

export function buildCapturePlan(input: CapturePlanInput) {
  assertNonClinicalMarketingBody(input.template.body);
  if (!input.template.approved) throw new Error('Select an approved template before scheduling.');
  if (!input.ownerApproval.approved) throw new Error('Owner approval is required before capture.');
  if (input.promotesRegulatedItem && !input.regulatoryApproval.d10Approved)
    throw new Error('This campaign cannot run because regulated-item outreach is not approved.');
  const hour = input.now.getUTCHours();
  const quiet =
    input.quietHours.startHour > input.quietHours.endHour
      ? hour >= input.quietHours.startHour || hour < input.quietHours.endHour
      : hour >= input.quietHours.startHour && hour < input.quietHours.endHour;
  if (quiet) throw new Error('This campaign is scheduled during quiet hours.');

  const captures: Array<{ campaignId: string; customerId: string; mode: 'CAPTURE' }> = [];
  const exclusions: Array<{
    campaignId: string;
    customerId: string;
    reason: CaptureExclusionReason;
    evaluatedAt: Date;
  }> = [];
  const windowStart = new Date(
    input.now.getTime() - input.frequencyCap.windowDays * 24 * 60 * 60 * 1000
  );
  for (const candidate of input.candidates) {
    const reason: CaptureExclusionReason | undefined = !candidate.consent
      ? 'NO_CONSENT'
      : !candidate.consent.granted
        ? 'OPTED_OUT'
        : candidate.priorCaptures.filter((date) => date >= windowStart).length >=
            input.frequencyCap.max
          ? 'FREQUENCY_CAP'
          : undefined;
    if (reason)
      exclusions.push({
        campaignId: input.campaignId,
        customerId: candidate.customerId,
        reason,
        evaluatedAt: input.now,
      });
    else
      captures.push({
        campaignId: input.campaignId,
        customerId: candidate.customerId,
        mode: 'CAPTURE',
      });
  }
  return { captures, exclusions };
}

type AttributionInput = {
  campaignId: string;
  method: string;
  windowDays: number;
  exclusions: string[];
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  links: Array<{
    visitId: string;
    receiptId: string;
    recoveredSalesMinor: number;
    recoveredMarginMinor: number;
    messageCostMinor: number;
  }>;
};

export function buildAttributionReport(input: AttributionInput) {
  const recoveredSalesMinor = input.links.reduce((sum, row) => sum + row.recoveredSalesMinor, 0);
  const recoveredMarginMinor = input.links.reduce((sum, row) => sum + row.recoveredMarginMinor, 0);
  const messageCostMinor = input.links.reduce((sum, row) => sum + row.messageCostMinor, 0);
  return {
    campaignId: input.campaignId,
    estimated: true as const,
    method: input.method,
    windowDays: input.windowDays,
    exclusions: input.exclusions,
    confidence: input.confidence,
    recoveredSalesMinor,
    recoveredMarginMinor,
    messageCostMinor,
    costPerRecoveredSaleMinor: input.links.length
      ? Math.round(messageCostMinor / input.links.length)
      : null,
    links: input.links,
  };
}
