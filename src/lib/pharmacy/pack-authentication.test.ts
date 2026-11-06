import { describe, expect, it } from 'vitest';

import { evaluatePackAuthentication } from './pack-authentication';
import { parseGs1DataMatrix } from './gs1-datamatrix';

const parsed = parseGs1DataMatrix('(01)08901234567890(17)251231(10)LOT-7(21)SERIAL-9');
const facts = {
  parsed,
  knownMedicineId: 'medicine-1',
  recordedBatch: { id: 'batch-1', batchNumber: 'LOT-7', expiry: '251231', recalled: false },
  serialSeenOnDifferentPack: false,
};

describe('evaluatePackAuthentication', () => {
  it('verifies matching known pack data', () => {
    expect(evaluatePackAuthentication(facts)).toMatchObject({ status: 'VERIFIED', issues: [] });
  });

  it('does not claim a batch match from a GTIN alone', () => {
    const gtinOnly = parseGs1DataMatrix('(01)08901234567890');
    expect(
      evaluatePackAuthentication({ ...facts, parsed: gtinOnly, recordedBatch: null })
    ).toMatchObject({
      status: 'NOT_VERIFIABLE',
      issues: ['NOT_VERIFIABLE'],
      advisory: true,
      explanation: expect.stringContaining('no batch number'),
    });
  });

  it('does not flag GS1 day 00 when it resolves to the recorded month end', () => {
    const monthEnd = parseGs1DataMatrix('(01)08901234567890(17)251200(10)LOT-7(21)SERIAL-9');
    expect(evaluatePackAuthentication({ ...facts, parsed: monthEnd })).toMatchObject({
      status: 'VERIFIED',
      issues: [],
    });
  });

  it('keeps missing and non-GS1 codes advisory and never labels them counterfeit', () => {
    const result = evaluatePackAuthentication({ ...facts, parsed: parseGs1DataMatrix('') });
    expect(result).toMatchObject({ status: 'NOT_VERIFIABLE', advisory: true });
    expect(result.explanation.toLowerCase()).not.toContain('counterfeit');
  });

  it('explains an organization-scoped duplicate serial without blocking', () => {
    const result = evaluatePackAuthentication({ ...facts, serialSeenOnDifferentPack: true });
    expect(result).toMatchObject({
      status: 'FLAGGED',
      advisory: true,
      issues: ['DUPLICATE_SERIAL'],
    });
    expect(result.explanation).toContain('organization-scoped');
  });

  it('flags unknown GTIN, batch and expiry mismatches', () => {
    expect(evaluatePackAuthentication({ ...facts, knownMedicineId: null }).issues).toContain(
      'UNKNOWN_GTIN'
    );
    expect(evaluatePackAuthentication({ ...facts, recordedBatch: null }).issues).toContain(
      'UNKNOWN_BATCH'
    );
    expect(
      evaluatePackAuthentication({
        ...facts,
        recordedBatch: { ...facts.recordedBatch!, expiry: '260101' },
      }).issues
    ).toContain('EXPIRY_MISMATCH');
  });

  it('leaves recall as the only blocking verdict', () => {
    expect(
      evaluatePackAuthentication({
        ...facts,
        recordedBatch: { ...facts.recordedBatch!, recalled: true },
      })
    ).toMatchObject({ status: 'BLOCKED_RECALL', advisory: false, issues: ['RECALLED_BATCH'] });
  });
});
