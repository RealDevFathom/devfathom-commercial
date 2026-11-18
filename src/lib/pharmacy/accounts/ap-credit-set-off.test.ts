import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  post: vi.fn(),
}));
vi.mock('@/lib/pharmacy/bookkeeping', () => ({ lockPharmacyLedgerScope: mocks.lock }));
vi.mock('@/lib/finance/journal', async () => ({
  ...(await vi.importActual<typeof import('@/lib/finance/journal')>('@/lib/finance/journal')),
  postJournalEntry: mocks.post,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  AP_SET_OFF_SEGREGATED_POLICY,
  AP_SET_OFF_SOLE_APPROVER_POLICY,
  apCreditSetOffPostingKey,
  approveApCreditSetOff,
  isSoleSetOffApprover,
  rejectApCreditSetOff,
  requestApCreditSetOff,
} from './ap-credit-set-off';

const NOW = new Date('2026-11-18T10:00:00.000Z');
const scope = { organizationId: 'org_1', branchId: 'branch_1', actorId: 'clerk_1' };
const managerScope = { ...scope, actorId: 'manager_1' };

type State = {
  invoice: Record<string, unknown> | null;
  credit: Record<string, unknown> | null;
  setOff: Record<string, unknown> | null;
  replay: Record<string, unknown> | null;
  allocatedMinor: number;
  setOffApprovedMinor: number;
  setOffPendingMinor: number;
  pendingOnInvoiceMinor: number;
};

function fixture(overrides: Partial<State> = {}) {
  const state: State = {
    invoice: {
      id: 'inv_1',
      reference: 'AP-1',
      payeeName: 'Al-Shifa Distributors',
      payeeKey: 'al-shifa distributors',
      supplierInvoiceRef: 'ASD-77',
      amountMinor: 50_000,
      currency: 'PKR',
      status: 'POSTED',
      invoiceDate: new Date('2026-11-01T00:00:00.000Z'),
      settlements: [
        {
          amountMinor: 10_000,
          paidAt: new Date('2026-11-10T00:00:00.000Z'),
          status: 'ACTIVE',
          reversedAt: null,
        },
      ],
      creditSetOffs: [],
    },
    credit: {
      id: 'cr_1',
      reference: 'CN-9',
      amountMinor: 30_000,
      supplier: { name: '  AL-SHIFA   distributors ' },
    },
    setOff: null,
    replay: null,
    allocatedMinor: 0,
    setOffApprovedMinor: 0,
    setOffPendingMinor: 0,
    pendingOnInvoiceMinor: 0,
    ...overrides,
  };
  const order: string[] = [];
  const db = {
    $queryRaw: vi.fn(async (sql: { strings: string[] }) => {
      const text = sql.strings.join('?');
      order.push(
        text.includes('pharmacy_ap_credit_set_offs')
          ? 'set-off-lock'
          : text.includes('pharmacy_supplier_credits')
            ? 'credit-lock'
            : 'invoice-lock'
      );
      return [];
    }),
    pharmacyApInvoice: { findFirst: vi.fn(async () => state.invoice) },
    pharmacySupplierCredit: { findFirst: vi.fn(async () => state.credit) },
    pharmacySupplierCreditAllocation: {
      aggregate: vi.fn(async () => ({ _sum: { amountMinor: state.allocatedMinor } })),
    },
    pharmacyApCreditSetOff: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
        'requestKey' in args.where || 'decisionKey' in args.where ? state.replay : state.setOff
      ),
      aggregate: vi.fn(async (args: { where: Record<string, unknown> }) => {
        if ('invoiceId' in args.where) {
          return { _sum: { amountMinor: state.pendingOnInvoiceMinor } };
        }
        const statuses = (args.where.status as { in: string[] }).in;
        return {
          _sum: {
            amountMinor:
              state.setOffApprovedMinor +
              (statuses.includes('PENDING') ? state.setOffPendingMinor : 0),
          },
        };
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'so_1',
        status: 'PENDING',
        ...args.data,
      })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        ...state.setOff,
        ...args.data,
      })),
    },
    user: { count: vi.fn(async () => 0) },
  };
  return { db, state, order, scoped: db as unknown as ScopedDb };
}

const request = {
  invoiceId: 'inv_1',
  supplierCreditId: 'cr_1',
  requestKey: 'ap-set-off:0001',
  amountMinor: 25_000,
};

const pendingSetOff = {
  id: 'so_1',
  branchId: 'branch_1',
  invoiceId: 'inv_1',
  supplierCreditId: 'cr_1',
  amountMinor: 25_000,
  currency: 'PKR',
  status: 'PENDING',
  requestedByUserId: 'clerk_1',
  decisionKey: null,
};

beforeEach(() => {
  mocks.lock.mockReset();
  mocks.post.mockReset();
  mocks.post.mockImplementation(async (_db, _scope, input) => ({
    id: 'entry_1',
    organizationId: 'org_1',
    branchId: 'branch_1',
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    reversesEntryId: null,
  }));
});

describe('requestApCreditSetOff', () => {
  it('records a PENDING request without posting anything', async () => {
    const { db, scoped, order } = fixture();
    const result = await requestApCreditSetOff(scoped, scope, { ...request, note: ' CN ' }, NOW);
    expect(result.replayed).toBe(false);
    expect(db.pharmacyApCreditSetOff.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        invoiceId: 'inv_1',
        supplierCreditId: 'cr_1',
        amountMinor: 25_000,
        currency: 'PKR',
        note: 'CN',
        requestedByUserId: 'clerk_1',
      }),
    });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.lock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['credit-lock', 'invoice-lock']);
  });

  it('refuses more than is left on the credit, counting pending requests and debit notes', async () => {
    const { scoped } = fixture({ allocatedMinor: 5_000, setOffPendingMinor: 1_000 });
    await expect(requestApCreditSetOff(scoped, scope, request, NOW)).rejects.toMatchObject({
      reason: 'SET_OFF_EXCEEDS_CREDIT',
    });
  });

  it('refuses more than the bill still owes, counting payments and pending requests', async () => {
    const { scoped } = fixture({ pendingOnInvoiceMinor: 20_000 });
    // 50,000 - 10,000 paid - 20,000 pending leaves 20,000.
    await expect(requestApCreditSetOff(scoped, scope, request, NOW)).rejects.toMatchObject({
      reason: 'SET_OFF_EXCEEDS_BILL',
    });
  });

  it('counts approved set-offs against the bill', async () => {
    const { scoped, state } = fixture();
    (state.invoice as { creditSetOffs: unknown[] }).creditSetOffs = [
      { amountMinor: 20_000, decidedAt: new Date('2026-11-12T00:00:00.000Z') },
    ];
    await expect(requestApCreditSetOff(scoped, scope, request, NOW)).rejects.toMatchObject({
      reason: 'SET_OFF_EXCEEDS_BILL',
    });
  });

  it("refuses a credit whose supplier is not the bill's payee", async () => {
    const { scoped, state } = fixture();
    state.credit = { ...state.credit, supplier: { name: 'Other Pharma' } };
    await expect(requestApCreditSetOff(scoped, scope, request, NOW)).rejects.toMatchObject({
      reason: 'SUPPLIER_MISMATCH',
    });
  });

  it('refuses a USD bill or a reversed bill', async () => {
    const usd = fixture();
    usd.state.invoice = { ...usd.state.invoice, currency: 'USD' };
    await expect(requestApCreditSetOff(usd.scoped, scope, request, NOW)).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    const reversed = fixture();
    reversed.state.invoice = { ...reversed.state.invoice, status: 'REVERSED' };
    await expect(requestApCreditSetOff(reversed.scoped, scope, request, NOW)).rejects.toMatchObject(
      { reason: 'INVALID_STATE' }
    );
  });

  it('refuses a non-positive amount and a credit outside the branch', async () => {
    const { scoped, state } = fixture();
    await expect(
      requestApCreditSetOff(scoped, scope, { ...request, amountMinor: 0 }, NOW)
    ).rejects.toMatchObject({ reason: 'INVALID_AMOUNT' });
    state.credit = null;
    await expect(requestApCreditSetOff(scoped, scope, request, NOW)).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });
  });

  it('replays the same key with the same payload and refuses a changed payload', async () => {
    const first = fixture();
    await requestApCreditSetOff(first.scoped, scope, request, NOW);
    const stored = first.db.pharmacyApCreditSetOff.create.mock.calls[0]![0].data;
    const again = fixture({ replay: { id: 'so_1', ...stored } });
    const replay = await requestApCreditSetOff(again.scoped, scope, request, NOW);
    expect(replay.replayed).toBe(true);
    expect(again.db.pharmacyApCreditSetOff.create).not.toHaveBeenCalled();
    await expect(
      requestApCreditSetOff(again.scoped, scope, { ...request, amountMinor: 1 }, NOW)
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('approveApCreditSetOff', () => {
  const decision = { setOffId: 'so_1', decisionKey: 'ap-set-off-ok:0001' };

  it('posts Dr accounts payable / Cr supplier claim receivable and approves', async () => {
    const { db, scoped, order } = fixture({ setOff: pendingSetOff });
    const soleApprover = vi.fn(async () => false);
    const result = await approveApCreditSetOff(scoped, managerScope, decision, {
      soleApprover,
      now: NOW,
    });
    expect(soleApprover).not.toHaveBeenCalled();
    expect(order).toEqual(['set-off-lock', 'credit-lock', 'invoice-lock']);
    expect(mocks.post).toHaveBeenCalledWith(
      scoped,
      managerScope,
      expect.objectContaining({
        sourceKind: 'PHARMACY_AP_CREDIT_SET_OFF',
        sourceId: 'so_1',
        idempotencyKey: apCreditSetOffPostingKey('so_1'),
        occurredAt: NOW,
        currency: 'PKR',
        lines: [
          expect.objectContaining({
            accountCode: 'ACCOUNTS_PAYABLE',
            side: 'DEBIT',
            amountMinor: 25_000,
          }),
          expect.objectContaining({
            accountCode: 'SUPPLIER_CLAIM_RECEIVABLE',
            side: 'CREDIT',
            amountMinor: 25_000,
          }),
        ],
      })
    );
    expect(db.pharmacyApCreditSetOff.update).toHaveBeenCalledWith({
      where: { id: 'so_1' },
      data: expect.objectContaining({
        status: 'APPROVED',
        decidedByUserId: 'manager_1',
        decidedAt: NOW,
        approvalPolicy: AP_SET_OFF_SEGREGATED_POLICY,
        journalEntryId: 'entry_1',
      }),
    });
    expect(result.selfApproved).toBe(false);
  });

  it('refuses the requester approving their own set-off when someone else could', async () => {
    const { db, scoped } = fixture({ setOff: pendingSetOff });
    await expect(
      approveApCreditSetOff(scoped, scope, decision, {
        soleApprover: async () => false,
        now: NOW,
      })
    ).rejects.toMatchObject({ reason: 'SELF_APPROVAL' });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(db.pharmacyApCreditSetOff.update).not.toHaveBeenCalled();
  });

  it('lets the only owner-level user approve their own request under the solo policy', async () => {
    const { db, scoped } = fixture({ setOff: pendingSetOff });
    const result = await approveApCreditSetOff(scoped, scope, decision, {
      soleApprover: async () => true,
      now: NOW,
    });
    expect(result.selfApproved).toBe(true);
    expect(db.pharmacyApCreditSetOff.update.mock.calls[0]![0].data.approvalPolicy).toBe(
      AP_SET_OFF_SOLE_APPROVER_POLICY
    );
  });

  it('re-checks the credit and the bill under lock at approval', async () => {
    const spent = fixture({ setOff: pendingSetOff, allocatedMinor: 10_000 });
    await expect(
      approveApCreditSetOff(spent.scoped, managerScope, decision, {
        soleApprover: async () => false,
        now: NOW,
      })
    ).rejects.toMatchObject({ reason: 'SET_OFF_EXCEEDS_CREDIT' });
    const paid = fixture({ setOff: pendingSetOff });
    (paid.state.invoice as { settlements: unknown[] }).settlements.push({
      amountMinor: 30_000,
      paidAt: new Date('2026-11-17T00:00:00.000Z'),
      status: 'ACTIVE',
      reversedAt: null,
    });
    await expect(
      approveApCreditSetOff(paid.scoped, managerScope, decision, {
        soleApprover: async () => false,
        now: NOW,
      })
    ).rejects.toMatchObject({ reason: 'SET_OFF_EXCEEDS_BILL' });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('refuses to post a set-off before the bill is dated', async () => {
    const { db, scoped, state } = fixture({ setOff: pendingSetOff });
    // A bill may be dated up to a day ahead of the clock.
    state.invoice = { ...state.invoice, invoiceDate: new Date('2026-11-19T00:00:00.000Z') };
    await expect(
      approveApCreditSetOff(scoped, managerScope, decision, {
        soleApprover: async () => false,
        now: NOW,
      })
    ).rejects.toMatchObject({ reason: 'INVALID_DATE' });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(db.pharmacyApCreditSetOff.update).not.toHaveBeenCalled();
  });

  it('refuses an already decided request', async () => {
    const { scoped } = fixture({ setOff: { ...pendingSetOff, status: 'REJECTED' } });
    await expect(
      approveApCreditSetOff(scoped, managerScope, decision, {
        soleApprover: async () => false,
        now: NOW,
      })
    ).rejects.toMatchObject({ reason: 'ALREADY_DECIDED' });
  });

  it('replays an approval key only for the same approved request', async () => {
    const approved = { ...pendingSetOff, status: 'APPROVED', decisionKey: decision.decisionKey };
    const { scoped } = fixture({ replay: approved });
    await expect(
      approveApCreditSetOff(scoped, managerScope, decision, {
        soleApprover: async () => false,
        now: NOW,
      })
    ).resolves.toMatchObject({ replayed: true });
    await expect(
      approveApCreditSetOff(
        scoped,
        managerScope,
        { ...decision, setOffId: 'so_2' },
        { soleApprover: async () => false, now: NOW }
      )
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('rejectApCreditSetOff', () => {
  it('closes a pending request with a reason and posts nothing', async () => {
    const { db, scoped } = fixture({ setOff: pendingSetOff });
    await rejectApCreditSetOff(
      scoped,
      managerScope,
      { setOffId: 'so_1', decisionKey: 'ap-set-off-no:0001', reason: ' Wrong bill ' },
      NOW
    );
    expect(db.pharmacyApCreditSetOff.update.mock.calls[0]![0].data).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Wrong bill',
      decidedByUserId: 'manager_1',
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('isSoleSetOffApprover', () => {
  it('is true only when no other active owner-level user exists', async () => {
    const { db, scoped } = fixture();
    await expect(isSoleSetOffApprover(scoped, 'org_1', 'owner_1')).resolves.toBe(true);
    expect(db.user.count).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', status: 'ACTIVE', role: 'ADMIN', id: { not: 'owner_1' } },
    });
    db.user.count.mockResolvedValueOnce(1);
    await expect(isSoleSetOffApprover(scoped, 'org_1', 'owner_1')).resolves.toBe(false);
  });
});
