/**
 * DEV-691: a draft receipt debit note is decided by a named person. These tests
 * drive the real `decideReceiptDebitNote` against a mocked tenant-scoped client.
 */
import { describe, expect, it, vi } from 'vitest';

import { decideReceiptDebitNote } from './goods-receipt';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const AT = new Date('2026-11-15T10:00:00.000Z');
const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_a' };

function draftDb(draft: Record<string, unknown> | null, updatedCount = 1) {
  const mocks = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyReceiptDebitNote: {
      findFirst: vi.fn().mockResolvedValue(
        draft && {
          id: 'rdn_1',
          organizationId: 'org_a',
          branchId: 'branch_a',
          status: 'DRAFT',
          totalMinor: 2_000,
          goodsReceipt: { status: 'POSTED' },
          ...draft,
        }
      ),
      updateMany: vi.fn().mockResolvedValue({ count: updatedCount }),
    },
  };
  return { db: mocks as unknown as ScopedDb, mocks };
}

describe('decideReceiptDebitNote (DEV-691)', () => {
  it('confirms a draft with the session actor and leaves the amount alone', async () => {
    const { db, mocks } = draftDb({});
    await expect(
      decideReceiptDebitNote(db, SCOPE, { debitNoteId: 'rdn_1', decision: 'CONFIRMED', at: AT })
    ).resolves.toEqual({ id: 'rdn_1', status: 'CONFIRMED', totalMinor: 2_000 });
    expect(mocks.pharmacyReceiptDebitNote.updateMany).toHaveBeenCalledWith({
      where: { id: 'rdn_1', organizationId: 'org_a', status: 'DRAFT' },
      data: {
        status: 'CONFIRMED',
        decidedAt: AT,
        decidedByUserId: 'user_a',
        decisionNote: null,
      },
    });
  });

  it('refuses to discard without a reason', async () => {
    const { db, mocks } = draftDb({});
    await expect(
      decideReceiptDebitNote(db, SCOPE, {
        debitNoteId: 'rdn_1',
        decision: 'DISCARDED',
        note: '   ',
        at: AT,
      })
    ).rejects.toMatchObject({ reason: 'BYPASS_EVIDENCE_MISSING' });
    expect(mocks.pharmacyReceiptDebitNote.updateMany).not.toHaveBeenCalled();
  });

  it('discards with the reason recorded', async () => {
    const { db, mocks } = draftDb({});
    await decideReceiptDebitNote(db, SCOPE, {
      debitNoteId: 'rdn_1',
      decision: 'DISCARDED',
      note: 'Distributor delivered the rest today',
      at: AT,
    });
    expect(mocks.pharmacyReceiptDebitNote.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'DISCARDED',
      decisionNote: 'Distributor delivered the rest today',
    });
  });

  it.each([
    ['an unknown draft', null, 'NOT_FOUND'],
    ['another branch', { branchId: 'branch_b' }, 'CROSS_BRANCH_REFERENCE'],
    ['a decided draft', { status: 'CONFIRMED' }, 'INVALID_TRANSITION'],
    ['a reversed receipt', { goodsReceipt: { status: 'REVERSED' } }, 'INVALID_TRANSITION'],
  ] as const)('refuses to confirm %s', async (_label, draft, reason) => {
    const { db, mocks } = draftDb(draft as Record<string, unknown> | null);
    await expect(
      decideReceiptDebitNote(db, SCOPE, { debitNoteId: 'rdn_1', decision: 'CONFIRMED', at: AT })
    ).rejects.toMatchObject({ reason });
    expect(mocks.pharmacyReceiptDebitNote.updateMany).not.toHaveBeenCalled();
  });

  it('refuses when a concurrent decision got there first', async () => {
    const { db } = draftDb({}, 0);
    await expect(
      decideReceiptDebitNote(db, SCOPE, { debitNoteId: 'rdn_1', decision: 'CONFIRMED', at: AT })
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSITION' });
  });
});
