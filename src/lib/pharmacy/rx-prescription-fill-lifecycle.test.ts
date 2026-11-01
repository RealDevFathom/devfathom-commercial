import { describe, expect, it, vi } from 'vitest';

import {
  activeFillUsage,
  nextFillSequence,
  reverseSaleFills,
} from './rx-prescription-reference';

// #410: fills bound to sale lines. The database trigger behaviour is covered against PostgreSQL
// in src/server/routers/pharmacy-sales.rx-prescription-reference.db.test.ts.
describe('prescription fill lifecycle (#410)', () => {
  const fills = [
    { fillSequence: 1, quantityCanonicalUnits: 10, reversedAt: new Date('2026-10-20') },
    { fillSequence: 2, quantityCanonicalUnits: 5, reversedAt: null },
  ];

  it('counts only fills that have not been reversed', () => {
    expect(activeFillUsage(fills)).toEqual({ filled: 5, events: 1 });
    expect(activeFillUsage([])).toEqual({ filled: 0, events: 0 });
  });

  it('never reuses a sequence number released by a reversal', () => {
    expect(nextFillSequence(fills)).toBe(3);
    expect(nextFillSequence([fills[0]!])).toBe(2);
    expect(nextFillSequence([])).toBe(1);
  });

  it('reverses only live fills bound to lines of the voided sale in this branch', async () => {
    const db = { $executeRaw: vi.fn().mockResolvedValue(1) };
    await expect(
      reverseSaleFills(
        db as never,
        { organizationId: 'org-a', branchId: 'branch-a', actorId: 'pharmacist-a' },
        'sale-a'
      )
    ).resolves.toBe(1);
    expect(db.$executeRaw).toHaveBeenCalledOnce();
    const query = db.$executeRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain('fill."reversedAt" IS NULL');
    expect(query.sql).toContain('fill."saleLineId" = line.id');
    expect(query.values).toEqual(['pharmacist-a', 'org-a', 'branch-a', 'sale-a']);
  });
});
