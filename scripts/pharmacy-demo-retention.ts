import { createHash } from 'node:crypto';
import type { RepeatReceipt } from '../src/lib/pharmacy/repeat-purchasing';
import { isPharmacyDemoNamespace } from './pharmacy-demo-contract';
import type { DemoGap, DemoPlannedRecord, PharmacyDemoContext, PharmacyDemoPlan,
  PharmacyDemoResult } from './pharmacy-demo-contract';

/** Expected cases only. These rows must NEVER be persisted as sale history. */
export type PharmacyDemoRetentionInput = PharmacyDemoContext;

const DAY = 86_400_000;
export function planPharmacyDemoRetention(input: PharmacyDemoRetentionInput) {
  for (const id of [input.organizationId, input.branchId, input.ownerUserId]) {
    if (!id.trim() || id.length > 128) throw new Error('Explicit existing target IDs required.');
  }
  if (!isPharmacyDemoNamespace(input.namespace))
    throw new Error('Use the canonical phdemo_<24 lowercase hex>_ namespace.');
  const asOf = new Date(input.scenarioAt);
  if (!Number.isFinite(asOf.getTime()) || !/Z$/.test(input.scenarioAt))
    throw new Error('An explicit UTC scenario instant is required.');
  // The owning report uses UTC calendar enrollment and elapsed days, even on PK targets.
  new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(asOf);
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: input.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(asOf);
  if (localDate !== input.businessDate || input.currency !== 'PKR')
    throw new Error('Business date must match scenarioAt in target timezone; currency must be PKR.');
  const at = (days: number) => new Date(asOf.getTime() + days * DAY);
  const ref = (key: string) => `${input.namespace}:retention:${key}`;
  const personas = ['repeat', 'single', 'partial-refund', 'immature', 'prior', 'excluded'].map(
    (key) => ({ ref: ref(key), displayName: `DEMO ${key}`, status: 'UNSEEDED' as const }),
  );
  const receipt = (key: string, customer: string | null, days: number): RepeatReceipt => ({
    id: ref(key), organizationId: input.organizationId, branchId: input.branchId,
    customerId: customer === null ? null : ref(customer), status: 'COMPLETED',
    originalSaleId: null, completedAt: at(days), createdAt: at(days), receiptNumber: 1,
    lines: [{ id: ref(`${key}-line`), quantity: 1, unitPriceMinor: 1000,
      discountMinor: 0, canonicalUnits: 1, createdAt: at(days), returnLines: [] }],
    refunds: [],
  });
  const expectedReceipts = [
    receipt('repeat-first', 'repeat', -90), receipt('repeat-boundary', 'repeat', -60),
    receipt('single-first', 'single', -90), receipt('partial-first', 'partial-refund', -90),
    receipt('immature-first', 'immature', -10), receipt('prior-first', 'prior', -91),
    receipt('prior-again', 'prior', -90), receipt('anonymous', null, -90),
    receipt('full-refund', 'excluded', -90), receipt('zero-value', 'excluded', -90),
    receipt('missing-receipt', 'excluded', -90), receipt('missing-time', 'excluded', -90),
    receipt('open', 'excluded', -90), receipt('fully-returned', 'excluded', -90),
  ];
  expectedReceipts[3].refunds = [{ id: ref('partial-refund-event'), amountMinor: 100, createdAt: at(-89) }];
  expectedReceipts[8].refunds = [{ id: ref('full-refund-event'), amountMinor: 1000, createdAt: at(-89) }];
  expectedReceipts[9].lines[0].unitPriceMinor = 0;
  expectedReceipts[10].receiptNumber = null;
  expectedReceipts[11].completedAt = null;
  expectedReceipts[12].status = 'OPEN';
  expectedReceipts[13].lines[0].returnLines = [{ id: ref('return-event'), canonicalUnits: 1,
    createdAt: at(-89), saleReturn: { createdAt: at(-89) } }];
  const filters = { branchIds: [input.branchId], from: at(-90).toISOString().slice(0, 10),
    to: at(-10).toISOString().slice(0, 10), asOf: asOf.toISOString() };
  const plan = {
    lane: 'retention' as const, namespace: input.namespace,
    // Expected receipts/personas are reference fixtures, never executable records.
    records: [] as DemoPlannedRecord[],
    gaps: [
      { function: 'repeat-purchasing', status: 'UNSEEDED',
        reason: 'Requires legitimately linked synthetic customers and finance service-generated receipt history; expected cases are not persisted records.' },
      { function: 'recovery', status: 'UNSEEDED',
        reason: 'No recovery activity or consent is seeded; absence of a repeat is not churn or clinical evidence.' },
      { function: 'gross-margin-comparison', status: 'UNSEEDED',
        reason: 'Requires approved service-generated journal references for both comparison windows; unavailable is not zero.' },
    ] satisfies DemoGap[],
    version: 1 as const, status: 'EXPECTED_CASE_ONLY' as const,
    target: { organizationId: input.organizationId, branchId: input.branchId,
      ownerUserId: input.ownerUserId, namespace: input.namespace,
      businessDate: input.businessDate, scenarioAt: asOf.toISOString(),
      timezone: input.timezone, currency: input.currency }, personas, expectedReceipts,
    // One immutable filter contract for both report and any future export adapter.
    filters, reportTimezone: 'UTC',
    expected: {
      enrolledCustomers: 4, completedReceipts: 11, identifiedReceipts: 10,
      anonymousReceipts: 1, excludedPurchases: 4, missingReceipt: 1, missingTimestamp: 1,
      firstObservedBeforeEnrollment: 1,
      horizons: [30, 60, 90].map((days) => ({ days, eligible: 3, repeated: 1,
        immature: 1, ratePercent: (1 / 3) * 100 })),
    },
    recovery: { status: 'UNSEEDED' as const, personaRef: ref('single'),
      reason: 'No later observed qualifying receipt is not churn, adherence failure or an outreach permission. No campaign, consent or capture is created.' },
    margin: { status: 'UNSEEDED' as const,
      previous: { from: at(-60).toISOString(), to: at(-30).toISOString() },
      current: { from: at(-30).toISOString(), to: asOf.toISOString() },
      service: 'src/lib/pharmacy/finance-reports.ts#grossMarginComparison',
      explanation: 'Posted ledger revenue minus discounts minus COGS. Delta is revenue delta minus discount delta minus COGS delta; not net profit or inferred price/mix causality. Windows are adjacent equal elapsed 30-day half-open UTC periods.',
      reason: 'No approved service-generated journal references supplied; absent entries cannot be presented as verified zero trading.' },
    prerequisites: [
      'Root must validate existing Pharmacy identity, branch authorization, report capability and observed module entitlements before any report read.',
      'Finance/context must supply approved service-generated original sale, line, completion, receipt, return and refund references at the exact case instants. Never backdate or insert these expected rows.',
      'Existing synthetic commercial identities must already be linked legitimately. customer-loyalty.ts#linkCustomerToSale requires LOYALTY consent and upserts customer displayName/active; this helper cannot fabricate consent or safely create/update identities through that service.',
      'Reconcile existing synthetic records and operator changes in root before any execution. Report aggregates include all selected branch history; these expected counts describe the isolated example set, not whole-target totals.',
    ],
    limitations: [
      'First observed qualifying purchase, not first-ever customer. Elapsed maturity does not prove complete history.',
      'Anonymous receipts count in identity coverage, not person denominators. Open, fully refunded, zero-value and fully returned receipts do not qualify; partial refund qualifies.',
      'Past identity/status changes, delayed ingestion, off-system history and observation completeness are unknown. No clinical inference.',
      'Current lifetime branch history is required by the existing report; its 10-second query budget may refuse large histories.',
      'No export writer, network effect, regulatory state, patient data or contact address is produced.',
    ],
  };
  return { ...plan, digest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') } satisfies PharmacyDemoPlan;
}

/** Deliberate refusal: no safe consent-free customer creation service exists at this base.
 * Root may consume the expected plan; this is never a substitute for service execution.
 * No database client, transaction, callback or top-level executable is accepted here.
 */
export async function executePharmacyDemoRetention(
  input: PharmacyDemoRetentionInput,
): Promise<PharmacyDemoResult> {
  const plan = planPharmacyDemoRetention(input);
  // Manually supplied actors, approved references and module flags cannot lift this refusal.
  return { status: 'refused', unmetPrerequisites: plan.prerequisites };
}
