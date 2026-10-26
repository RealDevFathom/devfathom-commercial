import { describe, expect, it } from 'vitest';
import { documentDto } from './pharmacy-general-journal';

describe('pharmacy general journal response', () => {
  it('does not expose replay, actor, or ledger-linkage fields', () => {
    const date = new Date('2026-10-25T12:00:00Z');
    const persistenceRow = {
      id: 'doc-1', branchId: 'branch-1', reference: 'JV-1', purpose: 'NONTRADE_OPERATING_ACCRUAL', status: 'POSTED',
      amountMinor: 100, currency: 'PKR', occurredAt: date, evidence: 'invoice', reason: 'accrual', version: 2,
      postedAt: date, cancelledAt: null, reversedAt: null, createdAt: date, updatedAt: date,
      createKey: 'secret', createPayloadHash: 'hash', postKey: 'secret', postPayloadHash: 'hash', createdByUserId: 'user-1', journalEntryId: 'entry-1',
    };
    const result = documentDto(persistenceRow);
    expect(result).not.toHaveProperty('createKey');
    expect(result).not.toHaveProperty('postPayloadHash');
    expect(result).not.toHaveProperty('createdByUserId');
    expect(result).not.toHaveProperty('journalEntryId');
  });
});
