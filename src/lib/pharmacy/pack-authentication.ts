import type { Gs1DataMatrixFields, Gs1DataMatrixParseResult } from './gs1-datamatrix';

export type PackAuthenticationIssue =
  | 'NOT_VERIFIABLE'
  | 'UNKNOWN_GTIN'
  | 'UNKNOWN_BATCH'
  | 'EXPIRY_MISMATCH'
  | 'DUPLICATE_SERIAL'
  | 'RECALLED_BATCH';

export type PackAuthenticationFacts = {
  parsed: Gs1DataMatrixParseResult;
  knownMedicineId: string | null;
  recordedBatch: { id: string; batchNumber: string; expiry: string; recalled: boolean } | null;
  serialSeenOnDifferentPack: boolean;
};

export type PackAuthenticationVerdict = {
  status: 'VERIFIED' | 'FLAGGED' | 'NOT_VERIFIABLE' | 'BLOCKED_RECALL';
  issues: PackAuthenticationIssue[];
  explanation: string;
  parsed: Gs1DataMatrixFields | null;
  advisory: boolean;
};

export function evaluatePackAuthentication(
  facts: PackAuthenticationFacts
): PackAuthenticationVerdict {
  if (facts.parsed.kind !== 'parsed') {
    return {
      status: 'NOT_VERIFIABLE',
      issues: ['NOT_VERIFIABLE'],
      explanation: `${facts.parsed.reason} The pack remains unverified and the scan does not block sale or dispensing.`,
      parsed: null,
      advisory: true,
    };
  }
  const issues: PackAuthenticationIssue[] = [];
  if (!facts.knownMedicineId) issues.push('UNKNOWN_GTIN');
  if (facts.parsed.fields.batch && facts.knownMedicineId && !facts.recordedBatch)
    issues.push('UNKNOWN_BATCH');
  if (
    facts.parsed.fields.expiryDate &&
    facts.recordedBatch &&
    facts.parsed.fields.expiryDate.slice(2).replaceAll('-', '') !== facts.recordedBatch.expiry
  )
    issues.push('EXPIRY_MISMATCH');
  if (facts.serialSeenOnDifferentPack) issues.push('DUPLICATE_SERIAL');
  if (facts.recordedBatch?.recalled) issues.push('RECALLED_BATCH');
  if (!issues.length && !facts.parsed.fields.batch)
    return {
      status: 'NOT_VERIFIABLE',
      issues: ['NOT_VERIFIABLE'],
      explanation: 'The code has no batch number. The pack cannot be matched to a recorded batch.',
      parsed: facts.parsed.fields,
      advisory: true,
    };
  if (!issues.length)
    return {
      status: 'VERIFIED',
      issues,
      explanation: 'GTIN and available lot details match this organization’s medicine register.',
      parsed: facts.parsed.fields,
      advisory: true,
    };
  const details: Record<PackAuthenticationIssue, string> = {
    NOT_VERIFIABLE: 'The pack could not be verified.',
    UNKNOWN_GTIN: 'The GTIN is not registered for a medicine in this organization.',
    UNKNOWN_BATCH: 'The encoded batch/lot is not recorded for the matched medicine.',
    EXPIRY_MISMATCH: 'The encoded expiry does not match the expiry recorded for this batch.',
    DUPLICATE_SERIAL:
      'This serial was already seen on a different pack in this organization; duplicate detection is organization-scoped.',
    RECALLED_BATCH: 'This batch is under recall and remains blocked by the existing recall path.',
  };
  return {
    status: issues.includes('RECALLED_BATCH') ? 'BLOCKED_RECALL' : 'FLAGGED',
    issues,
    explanation: issues.map((issue) => details[issue]).join(' '),
    parsed: facts.parsed.fields,
    advisory: !issues.includes('RECALLED_BATCH'),
  };
}
