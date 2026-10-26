import { describe, expect, it } from 'vitest';
import { createJournalDraftSchema } from './general-journal-schema';

describe('pharmacy journal input boundary', () => {
  const valid = { branchId: 'branch-1', reference: 'JV-1', purpose: 'NONTRADE_OPERATING_ACCRUAL', amountMinor: 100, currency: 'PKR', occurredAt: '2026-10-25T12:00:00Z', evidence: 'October electricity invoice', reason: 'Month-end accrual', idempotencyKey: 'request-1' };
  it('accepts the one allocated purpose and safe Int32 minor units', () => expect(createJournalDraftSchema.safeParse(valid).success).toBe(true));
  it.each([
    [{ ...valid, purpose: 'BANK_PAYMENT' }],
    [{ ...valid, amountMinor: 2_147_483_648 }],
    [{ ...valid, amountMinor: 1.5 }],
    [{ ...valid, evidence: ' ' }],
    [{ ...valid, occurredAt: 'not-a-date' }],
    [{ ...valid, extraAccount: 'BANK' }],
  ])('rejects inputs outside the sealed voucher contract', (input) => expect(createJournalDraftSchema.safeParse(input).success).toBe(false));
});
