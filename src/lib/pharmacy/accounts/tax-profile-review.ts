/** Recorded configuration evidence only; this does not validate law, rates, sales, or compliance. */
export type TaxProfileReviewDto = {
  id: string;
  organizationId: string;
  branchId: string;
  versionNumber: number;
  name: string;
  status: 'PUBLISHED' | 'DRAFT' | 'RETIRED';
  effectiveFrom: Date | string;
  effectiveTo: Date | string | null;
  approvalReference: string | null;
  approvedAt: Date | string | null;
  rules: Array<{
    id: string;
    organizationId: string;
    profileVersionId: string;
    productClass: string;
    pctHsCode: string;
    rate: string | { toString(): string };
    priceMode: string;
    roundingScale: number;
    sroReference: string | null;
    sroProvisional: boolean;
    exemptionCode: string | null;
  }>;
};

export type TaxRuleChange = {
  kind: 'ADDED' | 'REMOVED' | 'CHANGED';
  key: string;
  before: RuleEvidence | null;
  after: RuleEvidence | null;
};

export type RuleEvidence = {
  productClass: string;
  pctHsCode: string;
  rate: string;
  priceMode: string;
  roundingScale: number;
  sroReference: string | null;
  sroProvisional: boolean;
  exemptionCode: string | null;
};

export type TaxProfileReview = {
  scope: { organizationId: string; branchId: string };
  before: ProfileEvidence;
  after: ProfileEvidence;
  changes: TaxRuleChange[];
  disclaimer: string;
};

type ProfileEvidence = {
  id: string;
  versionNumber: number;
  name: string;
  approvalReference: string;
  approvedAt: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const disclaimer =
  'Recorded configuration evidence only — not statutory return or rate validation, sale eligibility, or compliance advice.';

function instant(value: Date | string | null, field: string): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}.`);
  return date.toISOString();
}

function approved(profile: TaxProfileReviewDto, organizationId: string, branchId: string) {
  if (
    profile.organizationId !== organizationId ||
    profile.branchId !== branchId ||
    profile.status !== 'PUBLISHED' ||
    !profile.approvalReference?.trim() ||
    !profile.approvedAt
  )
    throw new Error('Only selected, approved tax profile versions in this scope may be reviewed.');
  const keys = new Set<string>();
  const rules = new Map<string, RuleEvidence>();
  for (const rule of profile.rules) {
    const key = `${rule.productClass}\u0000${rule.pctHsCode}`;
    const rate = rule.rate.toString();
    if (
      rule.organizationId !== organizationId ||
      rule.profileVersionId !== profile.id ||
      keys.has(key) ||
      !rule.productClass ||
      !rule.pctHsCode ||
      !decimal.test(rate)
    )
      throw new Error('Tax profile DTO contains duplicate, foreign, or invalid rule evidence.');
    keys.add(key);
    rules.set(key, {
      productClass: rule.productClass,
      pctHsCode: rule.pctHsCode,
      rate,
      priceMode: rule.priceMode,
      roundingScale: rule.roundingScale,
      sroReference: rule.sroReference,
      sroProvisional: rule.sroProvisional,
      exemptionCode: rule.exemptionCode,
    });
  }
  return {
    evidence: {
      id: profile.id,
      versionNumber: profile.versionNumber,
      name: profile.name,
      approvalReference: profile.approvalReference,
      approvedAt: instant(profile.approvedAt, 'approvedAt')!,
      effectiveFrom: instant(profile.effectiveFrom, 'effectiveFrom')!,
      effectiveTo: instant(profile.effectiveTo, 'effectiveTo'),
    },
    rules,
  };
}

export function compareRecordedTaxProfiles(input: {
  organizationId: string;
  branchId: string;
  selectedVersionIds: readonly [string, string];
  profiles: readonly TaxProfileReviewDto[];
}): TaxProfileReview {
  const [beforeId, afterId] = input.selectedVersionIds;
  if (!beforeId || !afterId || beforeId === afterId)
    throw new Error('Select two different tax profile versions.');
  const selectedBefore = input.profiles.filter((profile) => profile.id === beforeId);
  const selectedAfter = input.profiles.filter((profile) => profile.id === afterId);
  if (selectedBefore.length !== 1 || selectedAfter.length !== 1)
    throw new Error('Selected tax profile versions were not found exactly once.');
  const before = approved(selectedBefore[0], input.organizationId, input.branchId);
  const after = approved(selectedAfter[0], input.organizationId, input.branchId);
  const keys = [...new Set([...before.rules.keys(), ...after.rules.keys()])].sort();
  const changes: TaxRuleChange[] = [];
  for (const key of keys) {
    const left = before.rules.get(key) ?? null;
    const right = after.rules.get(key) ?? null;
    if (!left) changes.push({ kind: 'ADDED', key, before: null, after: right });
    else if (!right) changes.push({ kind: 'REMOVED', key, before: left, after: null });
    else if (JSON.stringify(left) !== JSON.stringify(right))
      changes.push({ kind: 'CHANGED', key, before: left, after: right });
  }
  return {
    scope: { organizationId: input.organizationId, branchId: input.branchId },
    before: before.evidence,
    after: after.evidence,
    changes,
    disclaimer,
  };
}

function safeCsv(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function recordedTaxProfileReviewCsv(review: TaxProfileReview) {
  const header = [
    'change',
    'productClass',
    'pctHsCode',
    'beforeRate',
    'afterRate',
    'beforePriceMode',
    'afterPriceMode',
    'beforeRoundingScale',
    'afterRoundingScale',
    'beforeSroReference',
    'afterSroReference',
    'beforeSroProvisional',
    'afterSroProvisional',
    'beforeExemptionCode',
    'afterExemptionCode',
    'beforeApprovalReference',
    'afterApprovalReference',
    'beforeApprovedAt',
    'afterApprovedAt',
    'beforeEffectiveFrom',
    'beforeEffectiveTo',
    'afterEffectiveFrom',
    'afterEffectiveTo',
    'organizationId',
    'branchId',
    'beforeProfileId',
    'afterProfileId',
    'beforeVersionNumber',
    'afterVersionNumber',
    'beforeProfileName',
    'afterProfileName',
    'notice',
  ];
  // A no-change comparison still carries the selected profiles' recorded evidence.
  const changes = review.changes.length
    ? review.changes
    : [{ kind: 'UNCHANGED', before: null, after: null }];
  const rows = changes.map((change) => [
    change.kind,
    change.before?.productClass ?? change.after?.productClass,
    change.before?.pctHsCode ?? change.after?.pctHsCode,
    change.before?.rate,
    change.after?.rate,
    change.before?.priceMode,
    change.after?.priceMode,
    change.before?.roundingScale,
    change.after?.roundingScale,
    change.before?.sroReference,
    change.after?.sroReference,
    change.before?.sroProvisional,
    change.after?.sroProvisional,
    change.before?.exemptionCode,
    change.after?.exemptionCode,
    review.before.approvalReference,
    review.after.approvalReference,
    review.before.approvedAt,
    review.after.approvedAt,
    review.before.effectiveFrom,
    review.before.effectiveTo,
    review.after.effectiveFrom,
    review.after.effectiveTo,
    review.scope.organizationId,
    review.scope.branchId,
    review.before.id,
    review.after.id,
    review.before.versionNumber,
    review.after.versionNumber,
    review.before.name,
    review.after.name,
    review.disclaimer,
  ]);
  return `${[header, ...rows].map((row) => row.map(safeCsv).join(',')).join('\r\n')}\r\n`;
}
