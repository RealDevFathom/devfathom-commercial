// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }));

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { allocateSupplierCredit } from './supplier-returns-operations';

const scope = { organizationId: 'org_test', branchId: 'branch_test', actorId: 'controller' };
const at = new Date('2026-09-02T09:00:00Z');

function fixture() {
  type Allocation = {
    id: string;
    supplierCreditId: string;
    debitNoteId: string;
    amountMinor: number;
  };
  const allocations: Allocation[] = [];
  const credits = ['credit_a', 'credit_b'].map((id) => ({
    id,
    supplierId: 'supplier',
    amountMinor: 10_000,
  }));
  const notes = ['note_a', 'note_b'].map((id) => ({
    id,
    supplierId: 'supplier',
    purchaseReturnId: `return_${id}`,
    expectedCreditMinor: 10_000,
    status: 'OPEN',
    purchaseReturn: {
      status: 'DISPATCHED',
      submittedByUserId: 'clerk',
      settledAt: null as Date | null,
    },
  }));
  const tx = {
    $queryRawUnsafe: async () => [],
    // PostgreSQL row locks are reentrant inside one transaction. These cannot
    // block sibling operations using that same transaction connection.
    $queryRaw: async () => [{ id: 'locked' }],
    pharmacySupplierCredit: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        credits.find((credit) => credit.id === where.id) ?? null,
    },
    pharmacyDebitNote: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        const note = notes.find((note) => note.id === where.id);
        return note
          ? {
              ...note,
              purchaseReturn: { ...note.purchaseReturn },
              allocations: allocations.filter((allocation) => allocation.debitNoteId === note.id),
            }
          : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
        const note = notes.find((note) => note.id === where.id)!;
        Object.assign(note, data);
        return { ...note };
      },
    },
    pharmacySupplierCreditAllocation: {
      aggregate: async ({ where }: { where: { supplierCreditId: string } }) => ({
        _sum: {
          amountMinor: allocations
            .filter((allocation) => allocation.supplierCreditId === where.supplierCreditId)
            .reduce((sum, allocation) => sum + allocation.amountMinor, 0),
        },
      }),
      create: async ({ data }: { data: Omit<Allocation, 'id'> }) => {
        const allocation = { ...data, id: `allocation_${allocations.length}` };
        allocations.push(allocation);
        return allocation;
      },
    },
    pharmacyPurchaseReturn: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status: string; settledAt: Date };
      }) => {
        const note = notes.find((note) => note.purchaseReturnId === where.id)!;
        Object.assign(note.purchaseReturn, data);
        return { ...note.purchaseReturn };
      },
    },
  };
  mocks.transaction.mockImplementation(async (run: (db: ScopedDb) => Promise<unknown>) =>
    run(tx as unknown as ScopedDb)
  );
  return { allocations, notes };
}

describe('supplier allocations sharing a tenant transaction', () => {
  it.each(['credit', 'debit note'] as const)(
    'enforces the shared %s ceiling across concurrent nested mutations',
    async (shared) => {
      const state = fixture();
      const outcomes = await withTenantDb(
        scope.organizationId,
        (db) =>
          Promise.allSettled(
            [0, 1].map((index) =>
              db.$transaction((inner) =>
                allocateSupplierCredit(inner, scope, {
                  supplierCreditId: shared === 'credit' || index === 0 ? 'credit_a' : 'credit_b',
                  debitNoteId: shared === 'debit note' || index === 0 ? 'note_a' : 'note_b',
                  amountMinor: 10_000,
                  at,
                })
              )
            )
          ),
        { skipDrain: true }
      );

      expect(outcomes[0]!.status).toBe('fulfilled');
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { reason: 'OVER_ALLOCATION' },
      });
      expect(state.allocations).toHaveLength(1);
      expect(state.allocations[0]!.amountMinor).toBe(10_000);
      expect(state.notes.map((note) => note.status)).toEqual(['SETTLED', 'OPEN']);
    }
  );

  it('settles a note using two valid partial allocations in the same transaction', async () => {
    const state = fixture();
    const outcomes = await withTenantDb(
      scope.organizationId,
      (db) =>
        Promise.all(
          ['credit_a', 'credit_b'].map((supplierCreditId) =>
            allocateSupplierCredit(db, scope, {
              supplierCreditId,
              debitNoteId: 'note_a',
              amountMinor: 5_000,
              at,
            })
          )
        ),
      { skipDrain: true }
    );

    expect(outcomes.map((outcome) => outcome.position.receivedCreditMinor)).toEqual([
      5_000, 10_000,
    ]);
    expect(state.allocations).toHaveLength(2);
    expect(state.notes[0]).toMatchObject({
      status: 'SETTLED',
      purchaseReturn: { status: 'SETTLED', settledAt: at },
    });
  });

  it('allows a valid queued allocation after a domain refusal', async () => {
    const state = fixture();
    const outcomes = await withTenantDb(
      scope.organizationId,
      (db) =>
        Promise.allSettled(
          [10_001, 10_000].map((amountMinor) =>
            allocateSupplierCredit(db, scope, {
              supplierCreditId: 'credit_a',
              debitNoteId: 'note_a',
              amountMinor,
              at,
            })
          )
        ),
      { skipDrain: true }
    );

    expect(outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: { reason: 'OVER_ALLOCATION' },
    });
    expect(outcomes[1]!.status).toBe('fulfilled');
    expect(state.allocations).toHaveLength(1);
    expect(state.notes[0]!.status).toBe('SETTLED');
  });
});
