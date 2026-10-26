import { describe, expect, it } from 'vitest';
import { createGeneralJournalDraft, PharmacyGeneralJournalError } from './general-journal';
import { createJournalDraftSchema, GENERAL_JOURNAL_MAX_DATE, GENERAL_JOURNAL_MIN_DATE } from './general-journal-schema';

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
  it('accepts the lower date bound and rejects the exclusive upper bound', () => {
    expect(createJournalDraftSchema.safeParse({ ...valid, occurredAt: GENERAL_JOURNAL_MIN_DATE }).success).toBe(true);
    expect(createJournalDraftSchema.safeParse({ ...valid, occurredAt: new Date(GENERAL_JOURNAL_MIN_DATE.getTime() - 1) }).success).toBe(false);
    expect(createJournalDraftSchema.safeParse({ ...valid, occurredAt: GENERAL_JOURNAL_MAX_DATE }).success).toBe(false);
  });
});

describe('draft creation replay', () => {
  const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' };
  const input = { branchId: 'branch-1', reference: 'JV-1', purpose: 'NONTRADE_OPERATING_ACCRUAL' as const, amountMinor: 100, currency: 'PKR' as const, occurredAt: new Date('2026-10-25T12:00:00Z'), evidence: ' invoice ', reason: ' accrual ', idempotencyKey: 'key-1' };
  const baseDb = () => ({ $executeRaw: async () => 1, pharmacyGeneralJournalDocument: { findFirst: async () => null, create: async ({ data }: { data: object }) => data } });

  it('returns a same-branch replay only when the canonical payload matches', async () => {
    const first = await createGeneralJournalDraft(baseDb() as never, scope, input);
    const db = baseDb();
    db.pharmacyGeneralJournalDocument.findFirst = async () => first;
    await expect(createGeneralJournalDraft(db as never, scope, input)).resolves.toEqual(first);
    await expect(createGeneralJournalDraft(db as never, scope, { ...input, amountMinor: 101 })).rejects.toMatchObject<Partial<PharmacyGeneralJournalError>>({ reason: 'REPLAY_MISMATCH' });
  });

  it('does not return a document associated with the same key in another branch', async () => {
    const db = baseDb();
    let call = 0;
    db.pharmacyGeneralJournalDocument.findFirst = async () => (++call === 1 ? null : { id: 'other-branch-document' });
    await expect(createGeneralJournalDraft(db as never, scope, input)).rejects.toMatchObject<Partial<PharmacyGeneralJournalError>>({ reason: 'REPLAY_MISMATCH' });
  });
});
