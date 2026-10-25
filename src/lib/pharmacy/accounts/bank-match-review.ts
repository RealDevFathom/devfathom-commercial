/** Pure diagnostics for caller-supplied bank matches. This module does not establish source completeness. */

export const BANK_MATCH_REVIEW_FILENAME = 'bank-match-review.csv';
export const BANK_MATCH_REVIEW_LIMITATIONS =
  'SUPPLIED_DATA_ONLY: not authorization, reconciliation, or evidence that unsupplied transactions do not exist';

/** Mirrors the current-main schema enum; deliberately excludes non-schema PARTIAL states. */
export type PharmacyBankLineStatus = 'UNMATCHED' | 'MATCHED' | 'REVERSED';
export type BankMatchScope = Readonly<{ organizationId: string; branchId: string }>;
export type SuppliedProvenance = Readonly<{ kind: 'SUPPLIED'; sourceId: string }>;
export type ParentTransactionReferenceEvidence = Readonly<{
  referenceId: string;
  parentTransactionId: string;
  verified: true;
}>;
export type SuppliedBankMatch = Readonly<{
  id: string;
  bankLineId: string;
  scope: BankMatchScope;
  provenance: SuppliedProvenance;
  amountMinor: number;
  matchedAt: string;
  reversedAt: string | null;
  parentReference: ParentTransactionReferenceEvidence;
}>;
export type SuppliedBankLine = Readonly<{
  id: string;
  parentTransactionId: string;
  scope: BankMatchScope;
  provenance: SuppliedProvenance;
  amountMinor: number;
  status: PharmacyBankLineStatus;
  postedAt: string;
  matches: readonly SuppliedBankMatch[];
}>;
export type BankMatchReviewInput = Readonly<{
  scope: BankMatchScope;
  lines: readonly SuppliedBankLine[];
}>;

export type BankMatchDiagnostic = Readonly<{
  lineId: string;
  signedAmountMinor: bigint;
  activeMatchedMinor: bigint;
  reversedMatchedMinor: bigint;
  residualMinor: bigint | null;
  originalStatus: PharmacyBankLineStatus;
  matchCount: number;
  overallocated: boolean;
  evidenceVerified: boolean;
  limitations: typeof BANK_MATCH_REVIEW_LIMITATIONS;
}>;
export type BankMatchReview = Readonly<{
  scope: BankMatchScope;
  lines: readonly BankMatchDiagnostic[];
  evidenceVerified: boolean;
  limitations: typeof BANK_MATCH_REVIEW_LIMITATIONS;
}>;
export type BankMatchCsvArtifact = Readonly<{
  filename: typeof BANK_MATCH_REVIEW_FILENAME;
  mediaType: 'text/csv; charset=utf-8';
  bytes: Uint8Array;
  text: string;
}>;

const encoder = new TextEncoder();
const STATUSES = new Set<PharmacyBankLineStatus>(['UNMATCHED', 'MATCHED', 'REVERSED']);
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const CSV_COLUMNS = [
  'recordType',
  'organizationId',
  'branchId',
  'lineId',
  'matchId',
  'referenceId',
  'parentTransactionId',
  'postedOrMatchedAt',
  'reversedAt',
  'signedAmountMinor',
  'activeMatchedMinor',
  'reversedMatchedMinor',
  'residualMinor',
  'originalStatus',
  'recordMatchCount',
  'evidenceVerified',
  'limitations',
] as const;

function invalid(message: string): never {
  throw new TypeError(`Invalid bank match review input: ${message}`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} is required`);
  if (encoder.encode(value).byteLength > 256) invalid(`${label} exceeds 256 UTF-8 bytes`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(result) ||
    Number.isNaN(Date.parse(result))
  )
    invalid(`${label} is not an ISO UTC timestamp`);
  return result;
}
function safeInteger(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (positive && (value as number) <= 0))
    invalid(`${label} must be ${positive ? 'a positive ' : 'a '}safe integer`);
  return value as number;
}
function scope(value: BankMatchScope, expected: BankMatchScope, label: string): void {
  text(value?.organizationId, `${label}.organizationId`);
  text(value?.branchId, `${label}.branchId`);
  if (value.organizationId !== expected.organizationId || value.branchId !== expected.branchId)
    invalid(`${label} does not match the declared scope`);
}
function provenance(value: SuppliedProvenance, label: string): void {
  if (value?.kind !== 'SUPPLIED') invalid(`${label}.kind is unknown`);
  text(value.sourceId, `${label}.sourceId`);
}

export function reviewSuppliedBankMatches(input: BankMatchReviewInput): BankMatchReview {
  if (!input || !Array.isArray(input.lines)) invalid('lines must be an array');
  text(input.scope?.organizationId, 'scope.organizationId');
  text(input.scope?.branchId, 'scope.branchId');
  if (input.lines.length > 50) invalid('more than 50 lines supplied');
  input.lines.forEach((line, index) => {
    if (!Array.isArray(line?.matches) || line.matches.length > 200)
      invalid(`lines[${index}] has more than 200 matches`);
  });
  const lineIds = new Set<string>(),
    matchIds = new Set<string>(),
    referenceIds = new Set<string>();
  const lines = input.lines.map((line, lineIndex): BankMatchDiagnostic => {
    const prefix = `lines[${lineIndex}]`;
    const id = text(line?.id, `${prefix}.id`);
    if (lineIds.has(id)) invalid(`duplicate line id ${id}`);
    lineIds.add(id);
    scope(line.scope, input.scope, `${prefix}.scope`);
    provenance(line.provenance, `${prefix}.provenance`);
    const parentId = text(line.parentTransactionId, `${prefix}.parentTransactionId`);
    const amount = safeInteger(line.amountMinor, `${prefix}.amountMinor`);
    timestamp(line.postedAt, `${prefix}.postedAt`);
    if (!STATUSES.has(line.status)) invalid(`${prefix}.status is unknown`);
    let active = 0n,
      reversed = 0n,
      verified = true;
    line.matches.forEach((match, matchIndex) => {
      const mp = `${prefix}.matches[${matchIndex}]`;
      const matchId = text(match?.id, `${mp}.id`);
      if (matchIds.has(matchId)) invalid(`duplicate match id ${matchId}`);
      matchIds.add(matchId);
      if (text(match.bankLineId, `${mp}.bankLineId`) !== id)
        invalid(`${mp} has an inconsistent parent line`);
      scope(match.scope, input.scope, `${mp}.scope`);
      provenance(match.provenance, `${mp}.provenance`);
      const matchAmount = BigInt(safeInteger(match.amountMinor, `${mp}.amountMinor`, true));
      timestamp(match.matchedAt, `${mp}.matchedAt`);
      if (match.reversedAt !== null) timestamp(match.reversedAt, `${mp}.reversedAt`);
      const ref = match.parentReference;
      if (!ref || ref.verified !== true) {
        verified = false;
        return;
      }
      const referenceId = text(ref.referenceId, `${mp}.parentReference.referenceId`);
      if (referenceIds.has(referenceId)) invalid(`duplicate reference id ${referenceId}`);
      referenceIds.add(referenceId);
      if (text(ref.parentTransactionId, `${mp}.parentReference.parentTransactionId`) !== parentId)
        invalid(`${mp} has an inconsistent parent reference`);
      if (match.reversedAt === null) active += matchAmount;
      else reversed += matchAmount;
    });
    const absolute = BigInt(amount) < 0n ? -BigInt(amount) : BigInt(amount);
    const overallocated = active > absolute;
    return Object.freeze({
      lineId: id,
      signedAmountMinor: BigInt(amount),
      activeMatchedMinor: active,
      reversedMatchedMinor: reversed,
      residualMinor: verified && !overallocated ? absolute - active : null,
      originalStatus: line.status,
      matchCount: line.matches.length,
      overallocated,
      evidenceVerified: verified && !overallocated,
      limitations: BANK_MATCH_REVIEW_LIMITATIONS,
    });
  });
  return Object.freeze({
    scope: Object.freeze({ ...input.scope }),
    lines: Object.freeze(lines),
    evidenceVerified: lines.every((line) => line.evidenceVerified),
    limitations: BANK_MATCH_REVIEW_LIMITATIONS,
  });
}

const dangerousPrefix =
  /^[\s\u0000-\u001f\u007f\uFEFF\u200B-\u200F\u202A-\u202E\u2060-\u206F]*[=+\-@]/u;
function csv(value: string, numeric = false): string {
  const safe = !numeric && dangerousPrefix.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function exportBankMatchReviewCsv(input: BankMatchReviewInput): BankMatchCsvArtifact {
  const review = reviewSuppliedBankMatches(input);
  if (!review.evidenceVerified) invalid('verified evidence is required for export');
  const values: string[][] = [];
  if (input.lines.length === 0)
    values.push([
      'COVERAGE',
      input.scope.organizationId,
      input.scope.branchId,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '0',
      '0',
      '',
      '',
      '0',
      'true',
      BANK_MATCH_REVIEW_LIMITATIONS,
    ]);
  input.lines.forEach((line, index) => {
    const d = review.lines[index];
    values.push([
      'LINE',
      input.scope.organizationId,
      input.scope.branchId,
      line.id,
      '',
      '',
      line.parentTransactionId,
      line.postedAt,
      '',
      String(line.amountMinor),
      String(d.activeMatchedMinor),
      String(d.reversedMatchedMinor),
      String(d.residualMinor),
      line.status,
      String(line.matches.length),
      'true',
      BANK_MATCH_REVIEW_LIMITATIONS,
    ]);
    line.matches.forEach((match) =>
      values.push([
        'MATCH',
        input.scope.organizationId,
        input.scope.branchId,
        line.id,
        match.id,
        match.parentReference.referenceId,
        match.parentReference.parentTransactionId,
        match.matchedAt,
        match.reversedAt ?? '',
        String(match.amountMinor),
        match.reversedAt === null ? String(match.amountMinor) : '0',
        match.reversedAt === null ? '0' : String(match.amountMinor),
        '',
        line.status,
        '',
        'true',
        BANK_MATCH_REVIEW_LIMITATIONS,
      ])
    );
  });
  if (values.length > 10_050) invalid('more than 10050 data rows');
  const escaped = (row: readonly string[]) =>
    row.map((v, i) => csv(v, (i >= 9 && i <= 12) || i === 14)).join(',');
  const byteLength =
    encoder.encode(escaped(CSV_COLUMNS)).byteLength +
    1 +
    values.reduce((sum, row) => sum + encoder.encode(escaped(row)).byteLength + 1, 0);
  if (byteLength > MAX_ARTIFACT_BYTES) invalid('CSV artifact exceeds 8 MiB');
  const output = [escaped(CSV_COLUMNS), ...values.map(escaped)].join('\n') + '\n';
  return Object.freeze({
    filename: BANK_MATCH_REVIEW_FILENAME,
    mediaType: 'text/csv; charset=utf-8',
    bytes: encoder.encode(output),
    text: output,
  });
}
