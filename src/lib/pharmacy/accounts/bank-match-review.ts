/**
 * Bounded diagnostics over caller-supplied bank statement lines and their recorded matches.
 *
 * Pure supplied-data evidence: no reader, database, network, or write path. The scope and
 * provenance checks below reject inconsistent DTOs; they are NOT authorization. Amounts are
 * signed minor units exactly as supplied — no currency is inferred and no money is aggregated
 * across lines, so nothing here is a full, as-of, or complete statement claim.
 */

export const BANK_MATCH_REVIEW_CSV_FILENAME = 'bank-match-review.csv';

export const BANK_MATCH_REVIEW_LIMITS = Object.freeze({
  maxLines: 50,
  maxMatchesPerLine: 200,
  /** One LINE row per line plus one MATCH row per match: 50 + 50 × 200. */
  maxDataRows: 10_050,
  maxTextFieldBytes: 256,
  maxArtifactBytes: 8 * 1024 * 1024,
});

export const BANK_MATCH_LINE_STATUSES = ['UNMATCHED', 'MATCHED', 'REVERSED'] as const;
export type BankMatchLineStatus = (typeof BANK_MATCH_LINE_STATUSES)[number];

export const BANK_MATCH_LINE_SOURCE = 'pharmacy_bank_statement_lines';
export const BANK_MATCH_MATCH_SOURCE = 'pharmacy_bank_reconciliations';

export const BANK_MATCH_REVIEW_LIMITATIONS =
  'Supplied-data diagnostic only: covers only the lines and matches supplied by the caller; ' +
  'not a complete, full, or as-of statement; amounts are signed minor units with no currency ' +
  'inference and no cross-line totals; an unsampled parent reference is unknown, not absent.';

export type BankMatchParentEvidence =
  | {
      status: 'RESOLVED';
      kind: 'TRANSACTION' | 'SETTLEMENT_BATCH';
      id: string;
      organizationId: string;
      branchId: string;
      reference: string;
    }
  | { status: 'NOT_SAMPLED' };

export type BankMatchDto = {
  source: typeof BANK_MATCH_MATCH_SOURCE;
  id: string;
  organizationId: string;
  statementLineId: string;
  transactionId: string | null;
  settlementBatchId: string | null;
  amountMinor: number;
  reversedAt: Date | string | null;
  parent: BankMatchParentEvidence;
};

export type BankMatchLineDto = {
  source: typeof BANK_MATCH_LINE_SOURCE;
  id: string;
  organizationId: string;
  branchId: string;
  statementRef: string;
  lineReference: string;
  amountMinor: number;
  status: string;
  matches: readonly BankMatchDto[];
};

export type BankMatchReviewInput = {
  organizationId: string;
  branchId: string;
  lines: readonly BankMatchLineDto[];
};

export type BankMatchDiagnostic = 'NO_MATCHES' | 'BALANCED' | 'RESIDUAL' | 'OVERALLOCATED';

export type BankMatchReviewMatch = {
  id: string;
  parentKind: 'TRANSACTION' | 'SETTLEMENT_BATCH';
  parentId: string;
  parentReference: string | null;
  parentEvidence: 'RESOLVED' | 'UNKNOWN';
  state: 'ACTIVE' | 'REVERSED';
  amountMinor: string;
};

export type BankMatchReviewLine = {
  id: string;
  statementRef: string;
  lineReference: string;
  status: BankMatchLineStatus;
  amountMinor: string;
  activeMatchedMinor: string;
  reversedMatchedMinor: string;
  /** |amount| − active matches; null when over-allocated (diagnostic, not a verified residual). */
  residualAbsMinor: string | null;
  diagnostic: BankMatchDiagnostic;
  matches: BankMatchReviewMatch[];
};

export type BankMatchReview = {
  scope: { organizationId: string; branchId: string };
  lines: BankMatchReviewLine[];
  /** Non-empty when the review is diagnostic only and must not be exported as evidence. */
  exportBlockers: string[];
  limitations: string;
};

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).length;

function fail(message: string): never {
  throw new Error(`Bank match review rejected: ${message}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`missing ${field}.`);
  if (utf8Bytes(value) > BANK_MATCH_REVIEW_LIMITS.maxTextFieldBytes)
    fail(`${field} exceeds ${BANK_MATCH_REVIEW_LIMITS.maxTextFieldBytes} UTF-8 bytes.`);
  return value;
}

function safeInt(value: unknown, field: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    fail(`${field} must be a safe integer.`);
  return BigInt(value);
}

function instant(value: unknown, field: string): boolean {
  if (value === null) return false;
  if (!(value instanceof Date) && typeof value !== 'string') fail(`invalid ${field}.`);
  if (Number.isNaN(new Date(value).getTime())) fail(`invalid ${field}.`);
  return true;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function reviewSuppliedBankMatches(input: BankMatchReviewInput): BankMatchReview {
  const organizationId = text(input?.organizationId, 'organizationId');
  const branchId = text(input?.branchId, 'branchId');
  const lines = input.lines;
  if (!Array.isArray(lines)) fail('lines must be an array.');
  // Caps are enforced before any validation reduction or serialization; never truncated.
  if (lines.length > BANK_MATCH_REVIEW_LIMITS.maxLines)
    fail(`more than ${BANK_MATCH_REVIEW_LIMITS.maxLines} bank lines supplied.`);
  for (const line of lines) {
    if (!Array.isArray(line?.matches)) fail('line matches must be an array.');
    if (line.matches.length > BANK_MATCH_REVIEW_LIMITS.maxMatchesPerLine)
      fail(`more than ${BANK_MATCH_REVIEW_LIMITS.maxMatchesPerLine} matches on one line.`);
  }

  const lineIds = new Set<string>();
  const lineKeys = new Set<string>();
  const matchIds = new Set<string>();
  const exportBlockers = new Set<string>();
  const reviewed: BankMatchReviewLine[] = [];

  for (const line of lines) {
    if (line.source !== BANK_MATCH_LINE_SOURCE) fail('line provenance is missing or unknown.');
    const id = text(line.id, 'line id');
    if (line.organizationId !== organizationId || line.branchId !== branchId)
      fail('line is outside the declared organization and branch.');
    const statementRef = text(line.statementRef, 'statementRef');
    const lineReference = text(line.lineReference, 'lineReference');
    const key = `${statementRef}\u0000${lineReference}`;
    if (lineIds.has(id) || lineKeys.has(key)) fail('duplicate bank line identity.');
    lineIds.add(id);
    lineKeys.add(key);
    if (!(BANK_MATCH_LINE_STATUSES as readonly string[]).includes(line.status))
      fail('unknown bank line status.');
    const amount = safeInt(line.amountMinor, 'line amountMinor');

    const parents = new Set<string>();
    let active = BigInt(0);
    let reversed = BigInt(0);
    const matches: BankMatchReviewMatch[] = [];
    for (const match of line.matches) {
      if (match?.source !== BANK_MATCH_MATCH_SOURCE)
        fail('match provenance is missing or unknown.');
      const matchId = text(match.id, 'match id');
      if (matchIds.has(matchId)) fail('duplicate match identity.');
      matchIds.add(matchId);
      if (match.organizationId !== organizationId)
        fail('match is outside the declared organization.');
      if (match.statementLineId !== id) fail('match does not belong to its supplied line.');
      const hasTransaction = match.transactionId !== null && match.transactionId !== undefined;
      const hasBatch = match.settlementBatchId !== null && match.settlementBatchId !== undefined;
      if (hasTransaction === hasBatch) fail('match must reference exactly one parent.');
      const parentKind = hasTransaction ? 'TRANSACTION' : 'SETTLEMENT_BATCH';
      const parentId = text(
        hasTransaction ? match.transactionId : match.settlementBatchId,
        'match parent id'
      );
      if (parents.has(`${parentKind}\u0000${parentId}`)) fail('duplicate match parent on line.');
      parents.add(`${parentKind}\u0000${parentId}`);
      const magnitude = safeInt(match.amountMinor, 'match amountMinor');
      if (magnitude <= BigInt(0)) fail('match amountMinor must be positive.');
      const isReversed = instant(match.reversedAt, 'reversedAt');

      const parent = match.parent;
      let parentReference: string | null = null;
      let parentEvidence: BankMatchReviewMatch['parentEvidence'];
      if (parent?.status === 'RESOLVED') {
        if (
          parent.kind !== parentKind ||
          parent.id !== parentId ||
          parent.organizationId !== organizationId ||
          parent.branchId !== branchId
        )
          fail('resolved parent reference does not match the declared scope or match.');
        parentReference = text(parent.reference, 'parent reference');
        parentEvidence = 'RESOLVED';
      } else if (parent?.status === 'NOT_SAMPLED') {
        parentEvidence = 'UNKNOWN';
        exportBlockers.add('One or more parent references were not sampled (unknown).');
      } else fail('parent reference evidence is missing or unknown.');

      if (isReversed) reversed += magnitude;
      else active += magnitude;
      matches.push({
        id: matchId,
        parentKind,
        parentId,
        parentReference,
        parentEvidence,
        state: isReversed ? 'REVERSED' : 'ACTIVE',
        amountMinor: magnitude.toString(),
      });
    }

    const absolute = amount < BigInt(0) ? -amount : amount;
    const overallocated = active > absolute;
    if (overallocated) exportBlockers.add('One or more lines are over-allocated.');
    matches.sort((a, b) => byCodeUnit(a.id, b.id));
    reviewed.push({
      id,
      statementRef,
      lineReference,
      status: line.status as BankMatchLineStatus,
      amountMinor: amount.toString(),
      activeMatchedMinor: active.toString(),
      reversedMatchedMinor: reversed.toString(),
      residualAbsMinor: overallocated ? null : (absolute - active).toString(),
      diagnostic: overallocated
        ? 'OVERALLOCATED'
        : matches.length === 0
          ? 'NO_MATCHES'
          : active === absolute
            ? 'BALANCED'
            : 'RESIDUAL',
      matches,
    });
  }

  reviewed.sort(
    (a, b) =>
      byCodeUnit(a.statementRef, b.statementRef) ||
      byCodeUnit(a.lineReference, b.lineReference) ||
      byCodeUnit(a.id, b.id)
  );
  return {
    scope: { organizationId, branchId },
    lines: reviewed,
    exportBlockers: [...exportBlockers].sort(byCodeUnit),
    limitations: BANK_MATCH_REVIEW_LIMITATIONS,
  };
}

const HEADER = [
  'rowType',
  'organizationId',
  'branchId',
  'lineId',
  'statementRef',
  'lineReference',
  'lineStatus',
  'lineAmountMinor',
  'activeMatchedMinor',
  'reversedMatchedMinor',
  'residualAbsMinor',
  'diagnostic',
  'matchId',
  'matchState',
  'matchAmountMinor',
  'parentKind',
  'parentId',
  'parentReference',
  'parentEvidence',
  'limitations',
];

// Invisible/bidi/BOM characters can hide a formula prefix or reorder displayed cells.
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
const CONTROL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const FORMULA_PREFIX =
  /^[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20\uFE62\uFE63\u2212]/;

function textCell(value: string | null): string {
  let cell = (value ?? '').replace(INVISIBLE, '').replace(CONTROL, '');
  if (FORMULA_PREFIX.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}

function numberCell(value: string | null): string {
  if (value === null) return '""';
  if (!/^-?\d+$/.test(value)) fail('non-decimal amount reached export.');
  return `"${value}"`;
}

/**
 * Same-library evidence CSV. Throws — producing no partial output — for unverified reviews,
 * row-count overflow, or an escaped artifact above the byte cap (checked before joining).
 */
export function suppliedBankMatchReviewCsv(review: BankMatchReview): {
  filename: typeof BANK_MATCH_REVIEW_CSV_FILENAME;
  content: string;
} {
  if (review.exportBlockers.length > 0)
    fail(`no evidence export for unverified input (${review.exportBlockers.join(' ')})`);
  if (review.limitations !== BANK_MATCH_REVIEW_LIMITATIONS) fail('coverage limitations missing.');
  const rowCount = review.lines.reduce((total, line) => total + 1 + line.matches.length, 0);
  if (rowCount > BANK_MATCH_REVIEW_LIMITS.maxDataRows) fail('data row cap exceeded.');

  const { organizationId, branchId } = review.scope;
  const rows: string[] = [HEADER.map(textCell).join(',')];
  let bytes = utf8Bytes(rows[0]) + 2;
  const push = (cells: string[]) => {
    const row = cells.join(',');
    bytes += utf8Bytes(row) + 2;
    if (bytes > BANK_MATCH_REVIEW_LIMITS.maxArtifactBytes) fail('artifact byte cap exceeded.');
    rows.push(row);
  };
  const lineCells = (line: BankMatchReviewLine) => [
    textCell(organizationId),
    textCell(branchId),
    textCell(line.id),
    textCell(line.statementRef),
    textCell(line.lineReference),
    textCell(line.status),
    numberCell(line.amountMinor),
    numberCell(line.activeMatchedMinor),
    numberCell(line.reversedMatchedMinor),
    numberCell(line.residualAbsMinor),
    textCell(line.diagnostic),
  ];

  if (review.lines.length === 0) {
    // Empty output still states what was (not) covered.
    push([
      textCell('COVERAGE'),
      textCell(organizationId),
      textCell(branchId),
      ...Array.from({ length: HEADER.length - 4 }, () => textCell(null)),
      textCell(review.limitations),
    ]);
  }
  for (const line of review.lines) {
    const base = lineCells(line);
    push([
      textCell('LINE'),
      ...base,
      ...Array.from({ length: 7 }, () => textCell(null)),
      textCell(review.limitations),
    ]);
    for (const match of line.matches) {
      push([
        textCell('MATCH'),
        ...base,
        textCell(match.id),
        textCell(match.state),
        numberCell(match.amountMinor),
        textCell(match.parentKind),
        textCell(match.parentId),
        textCell(match.parentReference),
        textCell(match.parentEvidence),
        textCell(review.limitations),
      ]);
    }
  }
  return { filename: BANK_MATCH_REVIEW_CSV_FILENAME, content: `${rows.join('\r\n')}\r\n` };
}
