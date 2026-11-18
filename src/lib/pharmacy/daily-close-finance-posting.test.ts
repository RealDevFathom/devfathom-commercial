import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { cutPharmacyDailyClose } from '@/lib/pharmacy/settlement';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-280: cutting a pharmacy daily close posts its counted cash variance to the finance
 * journal (CASH / CASH_OVER_SHORT) in the close's own transaction, and a reopened close
 * replaces its predecessor's posting instead of adding to it.
 */
const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
const businessDate = new Date('2026-11-14');

type Row = Record<string, unknown> & { id: string };
type Line = { entryId: string; accountCode: string; side: 'DEBIT' | 'CREDIT'; amountMinor: number };

function fixture(drawer: { openingFloatMinor: number; countedCashMinor: number }) {
  const closes: Row[] = [];
  const entries: Row[] = [];
  const lines: Line[] = [];
  const withLines = (entry: Row) => ({ ...entry, lines: lines.filter((l) => l.entryId === entry.id) });
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => (row[key] ?? null) === value);

  const db = {
    pharmacyAccountingPeriod: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    // DEV-743: no card-terminal payment is open on the day.
    pharmacyCardTerminalAttempt: { count: vi.fn().mockResolvedValue(0) },
    pharmacyDrawerSession: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'drawer-1',
          countedCashMinor: drawer.countedCashMinor,
          movements: [{ kind: 'OPENING_FLOAT', amountMinor: drawer.openingFloatMinor }],
        },
      ]),
    },
    pharmacyDailyClose: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id) return closes.find((row) => row.id === where.id) ?? null;
        return closes.length ? closes[closes.length - 1] : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `close-${closes.length + 1}`, createdAt: new Date(), ...data };
        closes.push(row);
        return row;
      }),
    },
    pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyTender: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyParallelRunWindow: { count: vi.fn().mockResolvedValue(0) },
    camera: { findFirst: vi.fn().mockResolvedValue(null) },
    financeJournalEntry: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const found = entries.find((row) => matches(row, where));
        return found ? withLines(found) : null;
      }),
      findFirstOrThrow: vi.fn(async ({ where }: { where: { id: string } }) =>
        withLines(entries.find((row) => row.id === where.id)!)
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `entry-${entries.length + 1}`, reversesEntryId: null, ...data };
        entries.push(row);
        return row;
      }),
    },
    financeJournalLine: {
      create: vi.fn(async ({ data }: { data: Line }) => {
        lines.push(data);
        return data;
      }),
    },
  };
  /** Net signed movement of one account across every posted entry (debit positive). */
  const net = (accountCode: string) =>
    lines
      .filter((line) => line.accountCode === accountCode)
      .reduce((sum, line) => sum + (line.side === 'DEBIT' ? line.amountMinor : -line.amountMinor), 0);
  return { db, closes, entries, net };
}

const cut = (db: unknown, reopenReason?: string) =>
  cutPharmacyDailyClose(db as ScopedDb, scope, { businessDate, reopenReason });

describe('pharmacy daily close finance posting', () => {
  it('posts a cash shortage to CASH_OVER_SHORT against CASH', async () => {
    const { db, entries, net } = fixture({ openingFloatMinor: 10_000, countedCashMinor: 9_900 });
    const close = await cut(db);
    expect(close.cashVarianceMinor).toBe(-100);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceKind: 'PHARMACY_DAILY_CLOSE',
      sourceId: close.id,
      branchId: 'branch-1',
      idempotencyKey: `finance:PHARMACY_DAILY_CLOSE:${close.id}`,
    });
    expect(net('CASH_OVER_SHORT')).toBe(100);
    expect(net('CASH')).toBe(-100);
  });

  it('posts a cash overage to CASH against CASH_OVER_SHORT', async () => {
    const { db, entries, net } = fixture({ openingFloatMinor: 10_000, countedCashMinor: 10_050 });
    await cut(db);
    expect(entries).toHaveLength(1);
    expect(net('CASH')).toBe(50);
    expect(net('CASH_OVER_SHORT')).toBe(-50);
  });

  it('posts nothing when the drawer counts exactly to expectation', async () => {
    const { db, entries } = fixture({ openingFloatMinor: 10_000, countedCashMinor: 10_000 });
    await cut(db);
    expect(entries).toHaveLength(0);
  });

  it('reverses the superseded close on reopen so the variance is carried once', async () => {
    const { db, entries, net } = fixture({ openingFloatMinor: 10_000, countedCashMinor: 9_900 });
    const first = await cut(db);
    const second = await cut(db, 'Recount after found receipt');
    expect(second).toMatchObject({ sequence: 2, supersedesCloseId: first.id });
    expect(entries.map((e) => [e.sourceId, e.reversesEntryId ?? null])).toEqual([
      [first.id, null],
      [first.id, 'entry-1'],
      [second.id, null],
    ]);
    expect(net('CASH_OVER_SHORT')).toBe(100);
    expect(net('CASH')).toBe(-100);
  });
});
