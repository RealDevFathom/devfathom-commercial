export type TaxProfileStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export type RecordedTaxRule = Readonly<{
  id: string;
  organizationId: string;
  profileVersionId: string;
  productClass: string;
  pctHsCode: string;
  sroReference: string | null;
  sroProvisional: boolean;
  exemptionCode: string | null;
  priceMode: string;
  rate: string | null;
  roundingScale: number;
}>;

export type RecordedTaxProfile = Readonly<{
  id: string;
  organizationId: string;
  branchId: string;
  versionNumber: number;
  name: string;
  status: TaxProfileStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  approvalReference: string | null;
  approvedAt: string | null;
  rules: readonly RecordedTaxRule[];
}>;

export type TaxProfileReviewRow = Readonly<{
  key: string;
  productClass: string;
  pctHsCode: string;
  change: 'ADDED' | 'REMOVED' | 'CHANGED';
  before: RecordedTaxRule | null;
  after: RecordedTaxRule | null;
}>;

export type TaxProfileReview = Readonly<{
  scope: Readonly<{ organizationId: string; branchId: string }>;
  before: RecordedTaxProfile;
  after: RecordedTaxProfile;
  profileChanges: Readonly<{
    approval: boolean;
    effectiveWindow: boolean;
    status: boolean;
  }>;
  rows: readonly TaxProfileReviewRow[];
  coverage: 'supplied_two_versions_only_not_complete';
  snapshot: 'unverified_dto_provenance_not_authorization_or_snapshot';
}>;

export class TaxProfileReviewError extends Error {
  constructor(readonly reason: 'INVALID_SCOPE' | 'INVALID_PROFILE' | 'DUPLICATE_RULE') {
    super(reason);
    this.name = 'TaxProfileReviewError';
  }
}

export const MAX_TAX_REVIEW_RULES = 100 as const;
export const MAX_TAX_REVIEW_CSV_BYTES = 8 * 1024 * 1024;
const MAX_FIELD = 2048;
const text = (value: unknown, nullable = false): boolean =>
  (nullable && value === null) || (typeof value === 'string' && value.length <= MAX_FIELD);
const requiredText = (value: unknown): boolean =>
  text(value) && typeof value === 'string' && value.trim().length > 0;
const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const instant = (value: string | null) =>
  value === null || (Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const keyOf = (rule: RecordedTaxRule) => `${rule.productClass}\u0000${rule.pctHsCode}`;

function validateProfile(
  profile: RecordedTaxProfile,
  scope: { organizationId: string; branchId: string }
) {
  if (
    !requiredText(profile.id) ||
    !text(profile.name) ||
    !text(profile.approvalReference, true) ||
    profile.organizationId !== scope.organizationId ||
    profile.branchId !== scope.branchId ||
    !Number.isSafeInteger(profile.versionNumber) ||
    profile.versionNumber < 1 ||
    !['DRAFT', 'PUBLISHED', 'RETIRED'].includes(profile.status) ||
    typeof profile.effectiveFrom !== 'string' ||
    !text(profile.effectiveFrom) ||
    !(profile.effectiveTo === null || typeof profile.effectiveTo === 'string') ||
    !text(profile.effectiveTo, true) ||
    !(profile.approvedAt === null || typeof profile.approvedAt === 'string') ||
    !text(profile.approvedAt, true) ||
    !instant(profile.effectiveFrom) ||
    !instant(profile.effectiveTo) ||
    !instant(profile.approvedAt)
  )
    throw new TaxProfileReviewError('INVALID_PROFILE');

  const keys = new Set<string>();
  for (const rule of profile.rules) {
    if (
      !rule ||
      typeof rule !== 'object' ||
      !requiredText(rule.id) ||
      rule.organizationId !== scope.organizationId ||
      rule.profileVersionId !== profile.id ||
      !['MEDICINE', 'FRONT_SHOP'].includes(rule.productClass) ||
      !requiredText(rule.pctHsCode) ||
      !['INCLUSIVE', 'EXCLUSIVE'].includes(rule.priceMode) ||
      !text(rule.sroReference, true) ||
      !text(rule.exemptionCode, true) ||
      typeof rule.sroProvisional !== 'boolean' ||
      !(
        rule.rate === null ||
        (typeof rule.rate === 'string' && rule.rate.length <= 128 && decimal.test(rule.rate))
      ) ||
      !Number.isSafeInteger(rule.roundingScale) ||
      rule.roundingScale < 0
    )
      throw new TaxProfileReviewError('INVALID_PROFILE');
    const key = keyOf(rule);
    if (keys.has(key)) throw new TaxProfileReviewError('DUPLICATE_RULE');
    keys.add(key);
  }
}

// Comparison only: strip decimal trailing zeros without Number conversion; retain supplied strings in evidence.
const canonicalRate = (value: string | null) =>
  value === null ? null : value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const ruleEvidence = (rule: RecordedTaxRule) =>
  JSON.stringify([
    canonicalRate(rule.rate),
    rule.priceMode,
    rule.roundingScale,
    rule.sroReference,
    rule.sroProvisional,
    rule.exemptionCode,
  ]);

function immutableProfile(profile: RecordedTaxProfile): RecordedTaxProfile {
  return Object.freeze({
    id: profile.id,
    organizationId: profile.organizationId,
    branchId: profile.branchId,
    versionNumber: profile.versionNumber,
    name: profile.name,
    status: profile.status,
    effectiveFrom: profile.effectiveFrom,
    effectiveTo: profile.effectiveTo,
    approvalReference: profile.approvalReference,
    approvedAt: profile.approvedAt,
    rules: Object.freeze(
      profile.rules.map((rule) =>
        Object.freeze({
          id: rule.id,
          organizationId: rule.organizationId,
          profileVersionId: rule.profileVersionId,
          productClass: rule.productClass,
          pctHsCode: rule.pctHsCode,
          sroReference: rule.sroReference,
          sroProvisional: rule.sroProvisional,
          exemptionCode: rule.exemptionCode,
          priceMode: rule.priceMode,
          rate: rule.rate,
          roundingScale: rule.roundingScale,
        })
      )
    ),
  });
}

export function compareRecordedTaxProfiles(input: {
  scope: Readonly<{ organizationId: string; branchId: string }>;
  profiles: readonly RecordedTaxProfile[];
  beforeProfileId: string;
  afterProfileId: string;
}): TaxProfileReview {
  if (
    !input ||
    !input.scope ||
    !requiredText(input.scope.organizationId) ||
    !requiredText(input.scope.branchId)
  )
    throw new TaxProfileReviewError('INVALID_SCOPE');
  // Bound all collections before iteration, normalization, diff, or serialization.
  if (
    !Array.isArray(input.profiles) ||
    input.profiles.length !== 2 ||
    !requiredText(input.beforeProfileId) ||
    !requiredText(input.afterProfileId) ||
    input.beforeProfileId === input.afterProfileId
  )
    throw new TaxProfileReviewError('INVALID_PROFILE');
  for (const profile of input.profiles) {
    if (
      !profile ||
      typeof profile !== 'object' ||
      !Array.isArray(profile.rules) ||
      profile.rules.length > MAX_TAX_REVIEW_RULES
    )
      throw new TaxProfileReviewError('INVALID_PROFILE');
  }
  const profileIds = new Set<string>();
  for (const profile of input.profiles) {
    if (profileIds.has(profile.id)) throw new TaxProfileReviewError('INVALID_PROFILE');
    profileIds.add(profile.id);
    validateProfile(profile, input.scope);
  }
  const beforeInput = input.profiles.find((profile) => profile.id === input.beforeProfileId);
  const afterInput = input.profiles.find((profile) => profile.id === input.afterProfileId);
  if (!beforeInput || !afterInput || beforeInput.id === afterInput.id)
    throw new TaxProfileReviewError('INVALID_PROFILE');
  const before = immutableProfile(beforeInput);
  const after = immutableProfile(afterInput);

  const beforeRules = new Map(before.rules.map((rule) => [keyOf(rule), rule]));
  const afterRules = new Map(after.rules.map((rule) => [keyOf(rule), rule]));
  const rows: TaxProfileReviewRow[] = [];
  for (const key of [...new Set([...beforeRules.keys(), ...afterRules.keys()])].sort()) {
    const oldRule = beforeRules.get(key) ?? null;
    const newRule = afterRules.get(key) ?? null;
    const change = !oldRule
      ? 'ADDED'
      : !newRule
        ? 'REMOVED'
        : ruleEvidence(oldRule) !== ruleEvidence(newRule)
          ? 'CHANGED'
          : null;
    if (change) {
      const rule = oldRule ?? newRule!;
      rows.push({
        key: `${rule.productClass}:${rule.pctHsCode}`,
        productClass: rule.productClass,
        pctHsCode: rule.pctHsCode,
        change,
        before: oldRule,
        after: newRule,
      });
    }
  }

  return Object.freeze({
    scope: Object.freeze({
      organizationId: input.scope.organizationId,
      branchId: input.scope.branchId,
    }),
    before,
    after,
    profileChanges: Object.freeze({
      approval:
        before.approvalReference !== after.approvalReference ||
        before.approvedAt !== after.approvedAt,
      effectiveWindow:
        before.effectiveFrom !== after.effectiveFrom || before.effectiveTo !== after.effectiveTo,
      status: before.status !== after.status,
    }),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    coverage: 'supplied_two_versions_only_not_complete',
    snapshot: 'unverified_dto_provenance_not_authorization_or_snapshot',
  });
}

function safeCell(value: unknown) {
  const cleaned = String(value ?? '').replace(
    /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
    ' '
  );
  const protectedValue = /^[\s]*[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

export function taxProfileReviewCsv(supplied: TaxProfileReview): string {
  // Revalidate bounded inputs and use only canonical whitelisted evidence, not caller-injected rows.
  if (!supplied || !Array.isArray(supplied.rows) || supplied.rows.length > 200)
    throw new TaxProfileReviewError('INVALID_PROFILE');
  const review = compareRecordedTaxProfiles({
    scope: supplied.scope,
    profiles: [supplied.before, supplied.after],
    beforeProfileId: supplied.before?.id,
    afterProfileId: supplied.after?.id,
  });
  if (supplied.coverage !== review.coverage || supplied.snapshot !== review.snapshot)
    throw new TaxProfileReviewError('INVALID_PROFILE');
  // Do not inspect/stringify caller-supplied row payloads. Recompute from bounded, whitelisted profiles.

  const header = [
    'record_type',
    'change',
    'product_class',
    'pct_hs_code',
    'profile_side',
    'profile_id',
    'profile_version',
    'profile_status',
    'effective_from',
    'effective_to',
    'approval_reference',
    'approved_at',
    'before_rate',
    'after_rate',
    'before_price_mode',
    'after_price_mode',
    'before_sro_reference',
    'after_sro_reference',
    'before_sro_provisional',
    'after_sro_provisional',
    'before_exemption_code',
    'after_exemption_code',
    'before_rounding_scale',
    'after_rounding_scale',
    'before_rate_evidence',
    'after_rate_evidence',
    'coverage',
    'provenance',
    'before_rule_id',
    'after_rule_id',
    'organization_id',
    'branch_id',
  ];
  const profileLines = (
    [
      ['BEFORE', review.before],
      ['AFTER', review.after],
    ] as const
  ).map(([side, profile]) => [
    'PROFILE',
    '',
    '',
    '',
    side,
    profile.id,
    profile.versionNumber,
    profile.status,
    profile.effectiveFrom,
    profile.effectiveTo,
    profile.approvalReference,
    profile.approvedAt,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    review.coverage,
    review.snapshot,
    '',
    '',
    review.scope.organizationId,
    review.scope.branchId,
  ]);
  const lines = review.rows.map((row) => [
    'RULE',
    row.change,
    row.productClass,
    row.pctHsCode,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    row.before?.rate,
    row.after?.rate,
    row.before?.priceMode,
    row.after?.priceMode,
    row.before?.sroReference,
    row.after?.sroReference,
    row.before?.sroProvisional,
    row.after?.sroProvisional,
    row.before?.exemptionCode,
    row.after?.exemptionCode,
    row.before?.roundingScale,
    row.after?.roundingScale,
    row.before === null ? 'NO_RULE' : row.before.rate === null ? 'UNKNOWN' : 'KNOWN',
    row.after === null ? 'NO_RULE' : row.after.rate === null ? 'UNKNOWN' : 'KNOWN',
    review.coverage,
    review.snapshot,
    row.before?.id ?? '',
    row.after?.id ?? '',
    review.scope.organizationId,
    review.scope.branchId,
  ]);
  const records = [header, ...profileLines, ...lines];
  // Conservative exact-input bound BEFORE escaping, joining, or UTF-8 artifact allocation.
  // At most 203 records x 32 fields; six bytes per UTF-16 unit covers UTF-8 + doubled quotes.
  let byteUpperBound = 0;
  for (const record of records) {
    if (record.length !== header.length) throw new TaxProfileReviewError('INVALID_PROFILE');
    for (const value of record) byteUpperBound += String(value ?? '').length * 6 + 4;
    byteUpperBound += 2;
    if (byteUpperBound > MAX_TAX_REVIEW_CSV_BYTES)
      throw new TaxProfileReviewError('INVALID_PROFILE');
  }
  return records.map((line) => line.map(safeCell).join(',')).join('\r\n');
}

/** Pure supplied DTO -> artifact; no authorization, reader, DB or network callbacks. */
export function prepareTaxProfileReview(
  input: Parameters<typeof compareRecordedTaxProfiles>[0]
):
  | Readonly<{ kind: 'ready'; review: TaxProfileReview; csv: string }>
  | Readonly<{ kind: 'error'; csv: null }> {
  try {
    const review = compareRecordedTaxProfiles(input);
    return Object.freeze({ kind: 'ready', review, csv: taxProfileReviewCsv(review) });
  } catch {
    return Object.freeze({ kind: 'error', csv: null });
  }
}
