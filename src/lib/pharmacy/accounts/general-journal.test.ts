import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  cancelJournalVoucherDraft,
  commandPayloadHash,
  createJournalVoucherDraft,
  normalizeVoucherDraft,
  normalizeVoucherLines,
  parseVoucherInstant,
  postJournalVoucher,
  reverseJournalVoucher,
  updateJournalVoucherDraft,
  voucherPostingKey,
  voucherReversalKey,
} from './general-journal';
import {
  createJournalVoucherDraftSchema,
  postJournalVoucherSchema,
  reverseJournalVoucherSchema,
} from './general-journal-schema';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const scope = { organizationId: 'org_1', branchId: 'branch_1', actorId: 'owner_1' };

const debit = { accountCode: 'OPERATING_EXPENSE', side: 'DEBIT' as const, amountMinor: 50_000 };
const credit = {
  accountCode: 'MANUAL_NONTRADE_ACCRUAL',
  side: 'CREDIT' as const,
  amountMinor: 50_000,
};

const draftInput = {
  branchId: 'branch_1',
  createKey: 'create-key-0001',
  reference: 'JV-0001',
  purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
  occurredAt: '2026-11-10T09:00:00.000Z',
  currency: 'PKR' as const,
  reason: 'November electricity bill not yet paid',
  evidenceReference: 'K-Electric bill 2026-11',
  lines: [debit, credit],
};

function voucher(overrides: Record<string, unknown> = {}) {
  return {
    id: 'jv_1',
    organizationId: 'org_1',
    branchId: 'branch_1',
    reference: 'JV-0001',
    purpose: 'NONTRADE_OPERATING_ACCRUAL',
    status: 'DRAFT',
    version: 2,
    currency: 'PKR',
    occurredAt: new Date('2026-11-10T09:00:00.000Z'),
    reason: 'November electricity bill not yet paid',
    evidenceReference: 'K-Electric bill 2026-11',
    createdByUserId: 'owner_1',
    journalEntryId: null,
    reversalEntryId: null,
    postPayloadHash: null,
    reversePayloadHash: null,
    lines: [
      { lineNumber: 1, ...debit, memo: null },
      { lineNumber: 2, ...credit, memo: null },
    ],
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry_1',
    organizationId: 'org_1',
    branchId: 'branch_1',
    sourceKind: 'PHARMACY_JOURNAL_VOUCHER',
    sourceId: 'jv_1',
    reversesEntryId: null,
    currency: 'PKR',
    description: 'Journal voucher JV-0001',
    lines: [],
    ...overrides,
  };
}

function fakeDb(state: { voucher?: ReturnType<typeof voucher> | null; closed?: boolean } = {}) {
  const calls: string[] = [];
  const track = <T>(name: string, impl: (...args: unknown[]) => T) =>
    vi.fn((...args: unknown[]) => {
      calls.push(name);
      return impl(...args);
    });
  const db = {
    $queryRaw: track('queryRaw', (sql: unknown) => {
      const text = String((sql as { strings?: string[] }).strings?.join('?') ?? '');
      calls.push(text.includes('pg_advisory_xact_lock') ? 'ledger-lock' : 'voucher-lock');
      return Promise.resolve([]);
    }),
    pharmacyAccountingPeriod: {
      findFirst: track('periodCheck', () => Promise.resolve(state.closed ? { id: 'p1' } : null)),
    },
    pharmacyJournalVoucher: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        calls.push('voucher.findFirst');
        const where = args.where;
        if ('postCommandKey' in where || 'reverseCommandKey' in where || 'createKey' in where) {
          return null;
        }
        if ('reference' in where) return null;
        return state.voucher ?? null;
      }),
      create: track('voucher.create', (args: unknown) =>
        Promise.resolve({ id: 'jv_new', ...(args as { data: object }).data })
      ),
      update: track('voucher.update', (args: unknown) =>
        Promise.resolve({ ...state.voucher, ...(args as { data: object }).data })
      ),
    },
    pharmacyJournalVoucherLine: { deleteMany: track('lines.deleteMany', () => Promise.resolve()) },
    financeJournalEntry: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        calls.push('entry.findFirst');
        if ('idempotencyKey' in args.where) return null;
        if ('reversesEntryId' in args.where) return null;
        if (args.where.id === 'entry_1') return entry({ lines: [] });
        return null;
      }),
      findFirstOrThrow: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id === 'entry_rev'
          ? entry({ id: 'entry_rev', reversesEntryId: 'entry_1' })
          : entry()
      ),
      create: track('entry.create', (args: unknown) => {
        const data = (args as { data: { reversesEntryId?: string } }).data;
        return Promise.resolve({ id: data.reversesEntryId ? 'entry_rev' : 'entry_1' });
      }),
    },
    financeJournalLine: { create: track('line.create', () => Promise.resolve({})) },
  };
  return { db: db as unknown as ScopedDb, raw: db, calls };
}

describe('normalizeVoucherLines — the narrow account policy', () => {
  it('accepts the balanced accrual and orders it debit then credit', () => {
    expect(normalizeVoucherLines('NONTRADE_OPERATING_ACCRUAL', [credit, debit])).toEqual([
      { lineNumber: 1, ...debit, memo: null },
      { lineNumber: 2, ...credit, memo: null },
    ]);
  });

  it.each([
    [
      'swapped sides',
      [
        { ...debit, side: 'CREDIT' },
        { ...credit, side: 'DEBIT' },
      ],
    ],
    ['trade payable credit', [debit, { ...credit, accountCode: 'ACCOUNTS_PAYABLE' }]],
    ['cash credit', [debit, { ...credit, accountCode: 'CASH' }]],
    ['bank credit', [debit, { ...credit, accountCode: 'BANK' }]],
    ['inventory debit', [{ ...debit, accountCode: 'INVENTORY' }, credit]],
    ['revenue credit', [debit, { ...credit, accountCode: 'SALES_REVENUE' }]],
    ['a duplicated debit', [debit, debit]],
    ['a single leg', [debit]],
    ['three legs', [debit, credit, credit]],
  ])('refuses %s', (_label, lines) => {
    expect(() => normalizeVoucherLines('NONTRADE_OPERATING_ACCRUAL', lines as never)).toThrowError(
      expect.objectContaining({ reason: 'INVALID_LINES' })
    );
  });

  it('refuses any other purpose', () => {
    expect(() => normalizeVoucherLines('SUPPLIER_PAYMENT', [debit, credit])).toThrowError(
      expect.objectContaining({ reason: 'INVALID_PURPOSE' })
    );
  });

  it('refuses unbalanced legs', () => {
    expect(() =>
      normalizeVoucherLines('NONTRADE_OPERATING_ACCRUAL', [
        debit,
        { ...credit, amountMinor: 49_999 },
      ])
    ).toThrowError(expect.objectContaining({ reason: 'UNBALANCED' }));
  });

  it.each([0, -1, 1.5, 1_000_000_000, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'refuses amount %s outside the positive Int32-safe range',
    (amountMinor) => {
      expect(() =>
        normalizeVoucherLines('NONTRADE_OPERATING_ACCRUAL', [
          { ...debit, amountMinor },
          { ...credit, amountMinor },
        ])
      ).toThrowError(expect.objectContaining({ reason: 'INVALID_AMOUNT' }));
    }
  );

  it('accepts the cap exactly', () => {
    expect(
      normalizeVoucherLines('NONTRADE_OPERATING_ACCRUAL', [
        { ...debit, amountMinor: 999_999_999 },
        { ...credit, amountMinor: 999_999_999 },
      ])
    ).toHaveLength(2);
  });
});

describe('parseVoucherInstant and draft normalization', () => {
  it('rejects invalid, ancient and far-future dates', () => {
    for (const value of ['not-a-date', '1999-12-31T23:59:59.999Z', '2026-11-16T12:00:00.001Z']) {
      expect(() => parseVoucherInstant(value, NOW)).toThrowError(
        expect.objectContaining({ reason: 'INVALID_DATE' })
      );
    }
    expect(parseVoucherInstant('2026-11-16T12:00:00.000Z', NOW).toISOString()).toBe(
      '2026-11-16T12:00:00.000Z'
    );
  });

  it('requires an explicit reason and evidence reference', () => {
    expect(() => normalizeVoucherDraft({ ...draftInput, reason: '   ' }, NOW)).toThrowError(
      expect.objectContaining({ reason: 'MISSING_REASON' })
    );
    expect(() =>
      normalizeVoucherDraft({ ...draftInput, evidenceReference: ' ' }, NOW)
    ).toThrowError(expect.objectContaining({ reason: 'MISSING_EVIDENCE' }));
  });

  it('computes the voucher amount from the debit legs', () => {
    expect(normalizeVoucherDraft(draftInput, NOW).amountMinor).toBe(50_000);
  });
});

describe('wire schemas', () => {
  it('rejects unknown fields, other purposes and malformed command keys', () => {
    expect(createJournalVoucherDraftSchema.safeParse(draftInput).success).toBe(true);
    expect(
      createJournalVoucherDraftSchema.safeParse({ ...draftInput, journalEntryId: 'x' }).success
    ).toBe(false);
    expect(
      createJournalVoucherDraftSchema.safeParse({ ...draftInput, purpose: 'TRADE' }).success
    ).toBe(false);
    expect(
      postJournalVoucherSchema.safeParse({
        branchId: 'b',
        voucherId: 'v',
        expectedVersion: 1,
        commandKey: 'short',
      }).success
    ).toBe(false);
    expect(
      reverseJournalVoucherSchema.safeParse({
        branchId: 'b',
        voucherId: 'v',
        commandKey: 'reverse key with spaces',
        reason: 'x',
        at: '2026-11-10T00:00:00Z',
      }).success
    ).toBe(false);
    expect(
      createJournalVoucherDraftSchema.safeParse({ ...draftInput, occurredAt: '2026-11-10' }).success
    ).toBe(false);
  });
});

describe('commandPayloadHash', () => {
  it('is key-order independent and payload sensitive', () => {
    expect(commandPayloadHash({ a: 1, b: 'x' })).toBe(commandPayloadHash({ b: 'x', a: 1 }));
    expect(commandPayloadHash({ a: 1 })).not.toBe(commandPayloadHash({ a: 2 }));
  });
});

describe('draft lifecycle', () => {
  it('saves a draft with both lines under the caller scope', async () => {
    const { db, raw } = fakeDb();
    const saved = await createJournalVoucherDraft(db, scope, draftInput, NOW);
    expect(saved.status ?? 'DRAFT').toBe('DRAFT');
    const data = raw.pharmacyJournalVoucher.create.mock.calls[0]![0] as {
      data: { organizationId: string; branchId: string; lines: { create: unknown[] } };
    };
    expect(data.data.organizationId).toBe('org_1');
    expect(data.data.branchId).toBe('branch_1');
    expect(data.data.lines.create).toHaveLength(2);
  });

  // DEV-947: the line's relation to its voucher is the composite (organizationId,
  // branchId, voucherId), so Prisma copies the scope from the parent and its checked
  // nested input refuses those keys on a real database.
  const expectedLineRows = [
    { lineNumber: 1, ...debit, memo: null },
    { lineNumber: 2, ...credit, memo: null },
  ];

  it('creates nested lines without the scope keys Prisma copies from the voucher', async () => {
    const { db, raw } = fakeDb();
    await createJournalVoucherDraft(db, scope, draftInput, NOW);
    const data = raw.pharmacyJournalVoucher.create.mock.calls[0]![0] as {
      data: { lines: { create: Record<string, unknown>[] } };
    };
    expect(data.data.lines.create).toStrictEqual(expectedLineRows);
  });

  it('recreates edited lines without the scope keys Prisma copies from the voucher', async () => {
    const { db, raw } = fakeDb({ voucher: voucher() });
    await updateJournalVoucherDraft(
      db,
      scope,
      { ...draftInput, voucherId: 'jv_1', expectedVersion: 2 },
      NOW
    );
    const update = raw.pharmacyJournalVoucher.update.mock.calls[0]![0] as {
      where: { id: string };
      data: { lines: { create: Record<string, unknown>[] } };
    };
    expect(update.where).toEqual({ id: 'jv_1' });
    expect(update.data.lines.create).toStrictEqual(expectedLineRows);
    expect(raw.pharmacyJournalVoucherLine.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', voucherId: 'jv_1' },
    });
  });

  it('refuses to create a draft with a disallowed account before writing', async () => {
    const { db, raw } = fakeDb();
    await expect(
      createJournalVoucherDraft(
        db,
        scope,
        { ...draftInput, lines: [debit, { ...credit, accountCode: 'ACCOUNTS_PAYABLE' }] },
        NOW
      )
    ).rejects.toMatchObject({ reason: 'INVALID_LINES' });
    expect(raw.pharmacyJournalVoucher.create).not.toHaveBeenCalled();
  });

  it('edits only the expected draft version and bumps the version', async () => {
    const { db, raw } = fakeDb({ voucher: voucher() });
    await updateJournalVoucherDraft(
      db,
      scope,
      { ...draftInput, voucherId: 'jv_1', expectedVersion: 2 },
      NOW
    );
    const update = raw.pharmacyJournalVoucher.update.mock.calls[0]![0] as {
      data: { version: number };
    };
    expect(update.data.version).toBe(3);
    expect(raw.pharmacyJournalVoucherLine.deleteMany).toHaveBeenCalled();
  });

  it('refuses a stale edit and an edit of a posted voucher', async () => {
    await expect(
      updateJournalVoucherDraft(
        fakeDb({ voucher: voucher() }).db,
        scope,
        { ...draftInput, voucherId: 'jv_1', expectedVersion: 1 },
        NOW
      )
    ).rejects.toMatchObject({ reason: 'STALE_VERSION' });
    await expect(
      updateJournalVoucherDraft(
        fakeDb({ voucher: voucher({ status: 'POSTED', journalEntryId: 'entry_1' }) }).db,
        scope,
        { ...draftInput, voucherId: 'jv_1', expectedVersion: 2 },
        NOW
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('cancels a draft but never a posted voucher', async () => {
    const { db, raw } = fakeDb({ voucher: voucher() });
    await cancelJournalVoucherDraft(
      db,
      scope,
      { branchId: 'branch_1', voucherId: 'jv_1', expectedVersion: 2, reason: 'Duplicate' },
      NOW
    );
    expect(raw.pharmacyJournalVoucher.update.mock.calls[0]![0]).toMatchObject({
      data: { status: 'CANCELLED', cancelReason: 'Duplicate' },
    });
    await expect(
      cancelJournalVoucherDraft(
        fakeDb({ voucher: voucher({ status: 'POSTED', journalEntryId: 'entry_1' }) }).db,
        scope,
        { branchId: 'branch_1', voucherId: 'jv_1', expectedVersion: 2, reason: 'Late' },
        NOW
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });
});

const postInput = {
  branchId: 'branch_1',
  voucherId: 'jv_1',
  expectedVersion: 2,
  commandKey: 'post-key-0001',
};

describe('postJournalVoucher', () => {
  it('takes the ledger lock first, then the voucher lock, then posts one canonical entry', async () => {
    const { db, raw, calls } = fakeDb({ voucher: voucher() });
    const result = await postJournalVoucher(db, scope, postInput, NOW);
    expect(calls.indexOf('ledger-lock')).toBe(1);
    expect(calls.indexOf('ledger-lock')).toBeLessThan(calls.indexOf('voucher.findFirst'));
    expect(calls.indexOf('voucher-lock')).toBeLessThan(calls.indexOf('periodCheck'));
    expect(calls.indexOf('periodCheck')).toBeLessThan(calls.indexOf('entry.create'));
    const created = raw.financeJournalEntry.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(created.data).toMatchObject({
      sourceKind: 'PHARMACY_JOURNAL_VOUCHER',
      sourceId: 'jv_1',
      branchId: 'branch_1',
      idempotencyKey: voucherPostingKey('jv_1'),
    });
    const legs = raw.financeJournalLine.create.mock.calls.map(
      (call) => (call[0] as { data: { accountCode: string; side: string } }).data
    );
    expect(legs.map((leg) => `${leg.accountCode}:${leg.side}`)).toEqual([
      'OPERATING_EXPENSE:DEBIT',
      'MANUAL_NONTRADE_ACCRUAL:CREDIT',
    ]);
    expect(result.replayed).toBe(false);
    expect(raw.pharmacyJournalVoucher.update.mock.calls[0]![0]).toMatchObject({
      data: { status: 'POSTED', journalEntryId: 'entry_1', postCommandKey: 'post-key-0001' },
    });
  });

  it('replays the same command and payload without posting again', async () => {
    const { db, raw } = fakeDb();
    const posted = voucher({
      status: 'POSTED',
      journalEntryId: 'entry_1',
      postPayloadHash: commandPayloadHash({
        branchId: 'branch_1',
        voucherId: 'jv_1',
        expectedVersion: 2,
      }),
    });
    raw.pharmacyJournalVoucher.findFirst.mockResolvedValueOnce(posted as never);
    const result = await postJournalVoucher(db, scope, postInput, NOW);
    expect(result.replayed).toBe(true);
    expect(raw.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('refuses the same command key with a different payload', async () => {
    const { db, raw } = fakeDb();
    raw.pharmacyJournalVoucher.findFirst.mockResolvedValueOnce(
      voucher({ status: 'POSTED', journalEntryId: 'entry_1', postPayloadHash: 'other' }) as never
    );
    await expect(postJournalVoucher(db, scope, postInput, NOW)).rejects.toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });
    expect(raw.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('posts a document once: a second command key is refused', async () => {
    const { db, raw } = fakeDb({
      voucher: voucher({ status: 'POSTED', journalEntryId: 'entry_1' }),
    });
    await expect(
      postJournalVoucher(db, scope, { ...postInput, commandKey: 'post-key-0002' }, NOW)
    ).rejects.toMatchObject({ reason: 'ALREADY_POSTED' });
    expect(raw.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('refuses a stale version, a cancelled draft and a closed period', async () => {
    await expect(
      postJournalVoucher(fakeDb({ voucher: voucher({ version: 3 }) }).db, scope, postInput, NOW)
    ).rejects.toMatchObject({ reason: 'STALE_VERSION' });
    await expect(
      postJournalVoucher(
        fakeDb({ voucher: voucher({ status: 'CANCELLED' }) }).db,
        scope,
        postInput,
        NOW
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    const closed = fakeDb({ voucher: voucher(), closed: true });
    await expect(postJournalVoucher(closed.db, scope, postInput, NOW)).rejects.toMatchObject({
      reason: 'PERIOD_CLOSED',
    });
    expect(closed.raw.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('re-validates persisted lines and refuses a tampered draft', async () => {
    const tampered = voucher({
      lines: [
        { lineNumber: 1, ...debit, memo: null },
        { lineNumber: 2, ...credit, accountCode: 'CASH', memo: null },
      ],
    });
    const { db, raw } = fakeDb({ voucher: tampered });
    await expect(postJournalVoucher(db, scope, postInput, NOW)).rejects.toMatchObject({
      reason: 'INVALID_LINES',
    });
    expect(raw.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for a voucher outside the branch scope', async () => {
    await expect(
      postJournalVoucher(fakeDb({ voucher: null }).db, scope, postInput, NOW)
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });
});

const reverseInput = {
  branchId: 'branch_1',
  voucherId: 'jv_1',
  commandKey: 'reverse-key-0001',
  reason: 'Bill was raised against the wrong branch',
  at: '2026-11-12T00:00:00.000Z',
};

describe('reverseJournalVoucher', () => {
  it('writes one linked canonical reversal after the ledger lock and period check', async () => {
    const { db, raw, calls } = fakeDb({
      voucher: voucher({ status: 'POSTED', journalEntryId: 'entry_1' }),
    });
    const result = await reverseJournalVoucher(db, scope, reverseInput, NOW);
    expect(calls.indexOf('ledger-lock')).toBeLessThan(calls.indexOf('voucher.findFirst'));
    expect(calls.indexOf('periodCheck')).toBeLessThan(calls.indexOf('entry.create'));
    const created = raw.financeJournalEntry.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(created.data).toMatchObject({
      reversesEntryId: 'entry_1',
      sourceKind: 'PHARMACY_JOURNAL_VOUCHER',
      sourceId: 'jv_1',
      idempotencyKey: voucherReversalKey('jv_1'),
    });
    expect(result.voucher).toMatchObject({ status: 'REVERSED', reversalEntryId: 'entry_rev' });
  });

  it('refuses a draft, a second reversal, a date before the voucher and a closed period', async () => {
    await expect(
      reverseJournalVoucher(fakeDb({ voucher: voucher() }).db, scope, reverseInput, NOW)
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    await expect(
      reverseJournalVoucher(
        fakeDb({
          voucher: voucher({
            status: 'REVERSED',
            journalEntryId: 'entry_1',
            reversalEntryId: 'entry_rev',
          }),
        }).db,
        scope,
        { ...reverseInput, commandKey: 'reverse-key-0002' },
        NOW
      )
    ).rejects.toMatchObject({ reason: 'ALREADY_REVERSED' });
    await expect(
      reverseJournalVoucher(
        fakeDb({ voucher: voucher({ status: 'POSTED', journalEntryId: 'entry_1' }) }).db,
        scope,
        { ...reverseInput, at: '2026-11-09T00:00:00.000Z' },
        NOW
      )
    ).rejects.toMatchObject({ reason: 'INVALID_DATE' });
    const closed = fakeDb({
      voucher: voucher({ status: 'POSTED', journalEntryId: 'entry_1' }),
      closed: true,
    });
    await expect(reverseJournalVoucher(closed.db, scope, reverseInput, NOW)).rejects.toMatchObject({
      reason: 'PERIOD_CLOSED',
    });
    expect(closed.raw.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('replays an identical reverse command and refuses a changed payload', async () => {
    const hash = commandPayloadHash({
      branchId: 'branch_1',
      voucherId: 'jv_1',
      reason: reverseInput.reason,
      at: reverseInput.at,
    });
    const reversed = voucher({
      status: 'REVERSED',
      journalEntryId: 'entry_1',
      reversalEntryId: 'entry_rev',
      reversePayloadHash: hash,
    });
    const replay = fakeDb();
    replay.raw.pharmacyJournalVoucher.findFirst.mockResolvedValueOnce(reversed as never);
    await expect(reverseJournalVoucher(replay.db, scope, reverseInput, NOW)).resolves.toMatchObject(
      { replayed: true }
    );
    const changed = fakeDb();
    changed.raw.pharmacyJournalVoucher.findFirst.mockResolvedValueOnce(reversed as never);
    await expect(
      reverseJournalVoucher(changed.db, scope, { ...reverseInput, reason: 'Different' }, NOW)
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });
});
