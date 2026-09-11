import { describe, expect, it } from 'vitest';
import {
  supplierCreditFollowUp,
  type FollowUpCredit,
  type FollowUpReturn,
} from './supplier-credit-follow-up';

const scope = { organizationId: 'org', branchId: 'branch' };
const asOf = new Date('2026-09-06T12:00:00Z');
function claim(patch: Partial<FollowUpReturn> = {}): FollowUpReturn {
  return {
    ...scope,
    id: 'return',
    supplierId: 'supplier',
    supplier: { name: 'Supplier' },
    reference: 'Return 1',
    status: 'DISPATCHED',
    dispatchedAt: new Date('2026-09-01T00:00:00Z'),
    lines: [{ returnWindowEndsAt: new Date('2026-09-07T00:00:00Z') }],
    debitNotes: [
      {
        ...scope,
        id: 'note',
        supplierId: 'supplier',
        purchaseReturnId: 'return',
        reference: 'Note 1',
        status: 'OPEN',
        cancelledAt: null,
        issuedAt: new Date('2026-09-01T12:00:00Z'),
        expectedCreditMinor: 10000,
        allocations: [{ organizationId: 'org', debitNoteId: 'note', amountMinor: 2500 }],
      },
    ],
    ...patch,
  };
}
function credit(patch: Partial<FollowUpCredit> = {}): FollowUpCredit {
  return {
    ...scope,
    id: 'credit',
    supplierId: 'supplier',
    reference: 'Credit 1',
    amountMinor: 6000,
    allocations: [{ organizationId: 'org', supplierCreditId: 'credit', amountMinor: 1000 }],
    ...patch,
  };
}
function run(returns = [claim()], credits = [credit()]) {
  return supplierCreditFollowUp({ scope, asOf, returns, credits, coverage: 'complete' });
}

describe('supplier-credit priorities', () => {
  it('keeps partial allocation, outstanding claim and unallocated credit separate', () => {
    expect(run().claims[0]).toMatchObject({
      ageDays: 5,
      outstandingMinor: 7500,
      allocatedMinor: 2500,
      credits: [{ id: 'credit', unallocatedMinor: 5000 }],
    });
  });
  it.each(['DRAFT', 'SUBMITTED', 'CANCELLED', 'SETTLED'] as const)(
    'excludes %s returns from debt',
    (status) => {
      expect(run([claim({ status })]).claims).toEqual([]);
    }
  );
  it.each(['CANCELLED', 'SETTLED'] as const)('excludes %s notes', (status) => {
    const row = claim();
    row.debitNotes[0].status = status;
    expect(run([row]).claims).toEqual([]);
  });
  it('excludes cancellation evidence and fully allocated notes', () => {
    const row = claim();
    row.debitNotes[0].cancelledAt = asOf;
    expect(run([row]).claims).toEqual([]);
    row.debitNotes[0].cancelledAt = null;
    row.debitNotes[0].allocations[0].amountMinor = 10000;
    expect(run([row]).claims).toEqual([]);
  });
  it.each([-1, 1.5, NaN, Infinity, 10001, Number.MAX_SAFE_INTEGER])(
    'rejects invalid/overallocated note amount %s',
    (amount) => {
      const row = claim();
      row.debitNotes[0].allocations[0].amountMinor = amount;
      expect(run([row])).toMatchObject({ claims: [], excluded: 1 });
    }
  );
  it.each([-1, 6001, NaN, Infinity])('rejects invalid/overallocated credit amount %s', (amount) => {
    const row = credit();
    row.allocations[0].amountMinor = amount;
    expect(run(undefined, [row])).toMatchObject({ excluded: 1, claims: [{ credits: [] }] });
  });
  it('only matches the same supplier; credit suggestions do not reserve or consume funds', () => {
    const other = claim({ id: 'return2' });
    other.debitNotes[0].id = 'note2';
    other.debitNotes[0].purchaseReturnId = 'return2';
    other.debitNotes[0].allocations = [];
    const result = run(
      [claim(), other],
      [credit(), credit({ id: 'foreign', supplierId: 'other', allocations: [] })]
    );
    expect(result.claims.map((row) => row.credits.map((c) => c.id))).toEqual([
      ['credit'],
      ['credit'],
    ]);
  });
  it.each([{ organizationId: 'foreign' }, { branchId: 'foreign' }])(
    'rejects foreign scope %s on returns, notes and credits',
    (patch) => {
      expect(run([claim(patch)]).claims).toEqual([]);
      const row = claim();
      Object.assign(row.debitNotes[0], patch);
      expect(run([row])).toMatchObject({ claims: [], excluded: 1 });
      expect(run(undefined, [credit(patch)])).toMatchObject({
        excluded: 1,
        claims: [{ credits: [] }],
      });
    }
  );
  it('rejects mismatched note supplier and allocation ownership', () => {
    const row = claim();
    row.debitNotes[0].supplierId = 'other';
    expect(run([row]).excluded).toBe(1);
    row.debitNotes[0].supplierId = 'supplier';
    row.debitNotes[0].allocations[0].organizationId = 'other';
    expect(run([row]).excluded).toBe(1);
    const c = credit();
    c.allocations[0].supplierCreditId = 'other';
    expect(run(undefined, [c]).claims[0].credits).toEqual([]);
  });
  it('uses exact clock boundaries and never fabricates issue age', () => {
    const row = claim();
    for (const value of [null, new Date('invalid'), new Date(asOf.getTime() + 1)]) {
      row.debitNotes[0].issuedAt = value;
      expect(run([row]).claims[0].ageDays).toBeNull();
    }
    row.debitNotes[0].issuedAt = new Date(asOf.getTime() - 86400000 + 1);
    expect(run([row]).claims[0].ageDays).toBe(0);
    row.debitNotes[0].issuedAt = new Date(asOf.getTime() - 86400000);
    expect(run([row]).claims[0].ageDays).toBe(1);
  });
  it('sorts oldest exact issue timestamp first with unknown last', () => {
    const rows = [claim({ id: 'recent' }), claim({ id: 'unknown' }), claim({ id: 'oldest' })];
    rows.forEach((r) => {
      r.debitNotes[0].purchaseReturnId = r.id;
      r.debitNotes[0].id = r.id;
      r.debitNotes[0].allocations = [];
    });
    rows[1].debitNotes[0].issuedAt = null;
    rows[2].debitNotes[0].issuedAt = new Date('2026-08-01');
    expect(run(rows).claims.map((r) => r.returnId)).toEqual(['oldest', 'recent', 'unknown']);
  });
  it('closes dispatch exactly at deadline and excludes unsubmitted/already dispatched returns', () => {
    const row = claim({
      status: 'SUBMITTED',
      dispatchedAt: null,
      lines: [{ returnWindowEndsAt: asOf }],
    });
    expect(run([row]).dispatch[0].state).toBe('closed');
    row.lines[0].returnWindowEndsAt = new Date(asOf.getTime() + 1);
    expect(run([row]).dispatch[0].state).toBe('review');
    row.status = 'DRAFT';
    expect(run([row]).dispatch).toEqual([]);
    row.status = 'SUBMITTED';
    row.dispatchedAt = asOf;
    expect(run([row]).dispatch).toEqual([]);
  });
  it('keeps missing deadlines unknown and a known expired line blocks the whole return', () => {
    const row = claim({ status: 'SUBMITTED', dispatchedAt: null, lines: [] });
    expect(run([row]).dispatch[0]).toMatchObject({ state: 'unknown', deadline: null });
    row.lines = [
      { returnWindowEndsAt: null },
      { returnWindowEndsAt: new Date(asOf.getTime() + 1) },
    ];
    expect(run([row]).dispatch[0].state).toBe('unknown');
    row.lines[1].returnWindowEndsAt = asOf;
    expect(run([row]).dispatch[0].state).toBe('closed');
  });
  it('prioritizes upcoming deadlines before expired and unknown returns', () => {
    const submitted = (id: string, deadline: Date | null) =>
      claim({
        id,
        status: 'SUBMITTED',
        dispatchedAt: null,
        lines: [{ returnWindowEndsAt: deadline }],
      });
    const result = run([
      submitted('expired', new Date(asOf.getTime() - 1)),
      submitted('unknown', null),
      submitted('later', new Date(asOf.getTime() + 86400000)),
      submitted('next', new Date(asOf.getTime() + 1)),
    ]);
    expect(result.dispatch.map((row) => row.id)).toEqual(['next', 'later', 'expired', 'unknown']);
  });
  it('retains partial coverage rather than inventing branch totals', () => {
    expect(
      supplierCreditFollowUp({ scope, asOf, returns: [], credits: [], coverage: 'partial' })
        .coverage
    ).toBe('partial');
  });
  it('rejects an invalid as-of clock', () => {
    expect(() =>
      supplierCreditFollowUp({
        scope,
        asOf: new Date('invalid'),
        returns: [],
        credits: [],
        coverage: 'complete',
      })
    ).toThrow('explicit as-of');
  });
});
