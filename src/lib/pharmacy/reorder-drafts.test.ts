import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  confirmedReorderLines,
  planReorderDrafts,
  readReorderFacts,
  ReorderConfirmationError,
  REORDER_DEFAULT_LEAD_TIME_DAYS,
  type ReorderFact,
} from './reorder-drafts';

const policy = { windowDays: 28, coverDays: 14 };

function fact(overrides: Partial<ReorderFact> = {}): ReorderFact {
  return {
    medicineId: 'med_a',
    medicineName: 'Alpha 500mg',
    soldUnits: 280,
    onHandUnits: 50,
    inboundUnits: 0,
    supplierId: 'sup_a',
    supplierName: 'Karachi Distributors',
    supplierActive: true,
    packLevelId: 'pack_a',
    canonicalUnitsPerPack: 20,
    listPricePerPackMinor: 15_000,
    discountBps: 500,
    taxBps: 1_700,
    taxCreditable: false,
    lineLeadTimeDays: 7,
    observedLeadTimeDays: null,
    ...overrides,
  };
}

describe('planReorderDrafts (DEV-678)', () => {
  it('works out packs from sales velocity, lead time, cover, stock and open orders', () => {
    // 280 units / 28 days = 10/day; (7 lead + 14 cover) × 10 = 210; 210 − 50 − 20 = 140 → 7 packs.
    const plan = planReorderDrafts([fact({ inboundUnits: 20 })], policy);
    expect(plan.drafts).toHaveLength(1);
    const [line] = plan.drafts[0]!.lines;
    expect(line).toMatchObject({
      targetUnits: 210,
      shortfallUnits: 140,
      suggestedPacks: 7,
      leadTimeDays: 7,
      leadTimeSource: 'LAST_ORDER_TERMS',
      listPricePerPackMinor: 15_000,
    });
    expect(plan.drafts[0]!.listValueMinor).toBe(7 * 15_000);
    expect(line!.explanation).toContain('Sold 280 units in 28 days');
    expect(line!.explanation).toContain('7 packs of 20');
  });

  it('rounds a partial pack up and the target up', () => {
    // 10 sold over 28 days, 21-day horizon → ⌈210/28⌉ = 8; short 8 → 1 pack of 20.
    const plan = planReorderDrafts([fact({ soldUnits: 10, onHandUnits: 0 })], policy);
    expect(plan.drafts[0]!.lines[0]).toMatchObject({ targetUnits: 8, suggestedPacks: 1 });
  });

  it('drafts one order per distributor and leaves covered medicines out', () => {
    const plan = planReorderDrafts(
      [
        fact(),
        fact({
          medicineId: 'med_b',
          medicineName: 'Beta',
          supplierId: 'sup_b',
          supplierName: 'Zed Pharma',
        }),
        fact({ medicineId: 'med_c', medicineName: 'Gamma' }),
        fact({ medicineId: 'med_d', medicineName: 'Delta', onHandUnits: 1_000 }),
      ],
      policy
    );
    expect(plan.drafts.map((draft) => draft.supplierName)).toEqual([
      'Karachi Distributors',
      'Zed Pharma',
    ]);
    expect(plan.drafts[0]!.lines.map((line) => line.medicineId)).toEqual(['med_a', 'med_c']);
    expect(plan.drafts.flatMap((draft) => draft.lines).some((l) => l.medicineId === 'med_d')).toBe(
      false
    );
  });

  it('falls back to observed deliveries, then a labelled default lead time', () => {
    const plan = planReorderDrafts(
      [
        fact({ lineLeadTimeDays: null, observedLeadTimeDays: 3 }),
        fact({
          medicineId: 'med_b',
          medicineName: 'Beta',
          lineLeadTimeDays: null,
          observedLeadTimeDays: null,
        }),
      ],
      policy
    );
    const [a, b] = plan.drafts[0]!.lines;
    expect(a).toMatchObject({ leadTimeDays: 3, leadTimeSource: 'OBSERVED_DELIVERIES' });
    expect(b).toMatchObject({
      leadTimeDays: REORDER_DEFAULT_LEAD_TIME_DAYS,
      leadTimeSource: 'DEFAULT',
    });
  });

  it('lists a short medicine with no orderable distributor instead of dropping it', () => {
    const plan = planReorderDrafts(
      [
        fact({ supplierId: null, supplierName: null, packLevelId: null }),
        fact({ medicineId: 'med_b', medicineName: 'Beta', supplierActive: false }),
      ],
      policy
    );
    expect(plan.drafts).toEqual([]);
    expect(plan.unassigned).toEqual([
      {
        medicineId: 'med_a',
        medicineName: 'Alpha 500mg',
        shortfallUnits: 160,
        reason: 'NO_DISTRIBUTOR',
      },
      {
        medicineId: 'med_b',
        medicineName: 'Beta',
        shortfallUnits: 160,
        reason: 'SUPPLIER_INACTIVE',
      },
    ]);
  });

  it('refuses impossible inputs', () => {
    expect(() => planReorderDrafts([fact({ soldUnits: -1 })], policy)).toThrow(RangeError);
    expect(() => planReorderDrafts([fact({ onHandUnits: 1.5 })], policy)).toThrow(RangeError);
    expect(() => planReorderDrafts([], { windowDays: 0, coverDays: 1 })).toThrow(RangeError);
    expect(() => planReorderDrafts([], { windowDays: 28, coverDays: 91 })).toThrow(RangeError);
  });
});

describe('confirmedReorderLines (DEV-678)', () => {
  const draft = planReorderDrafts(
    [fact(), fact({ medicineId: 'med_b', medicineName: 'Beta', listPricePerPackMinor: 900 })],
    policy
  ).drafts[0]!;

  it('takes the person’s packs and the server’s terms; zero drops a line', () => {
    const lines = confirmedReorderLines(
      draft,
      new Map([
        ['med_a', 3],
        ['med_b', 0],
      ])
    );
    expect(lines).toEqual([
      {
        medicineId: 'med_a',
        packLevelId: 'pack_a',
        orderedPacks: 3,
        canonicalUnitsPerPack: 20,
        listPricePerPackMinor: 15_000,
        discountBps: 500,
        taxBps: 1_700,
        taxCreditable: false,
      },
    ]);
  });

  it('never orders a line the person was not shown (stale form)', () => {
    expect(() => confirmedReorderLines(draft, new Map())).toThrow(/changed since the page loaded/);
    expect(() => confirmedReorderLines(draft, new Map([['med_a', 3]]))).toThrow(
      ReorderConfirmationError
    );
  });

  it('refuses a medicine outside the draft, bad packs, and an empty order', () => {
    expect(() => confirmedReorderLines(draft, new Map([['med_x', 1]]))).toThrow(
      ReorderConfirmationError
    );
    expect(() => confirmedReorderLines(draft, new Map([['med_a', -1]]))).toThrow(/whole number/);
    expect(() => confirmedReorderLines(draft, new Map([['med_a', 1.5]]))).toThrow(
      ReorderConfirmationError
    );
    expect(() =>
      confirmedReorderLines(
        draft,
        new Map([
          ['med_a', 0],
          ['med_b', 0],
        ])
      )
    ).toThrow(/at least one line/);
  });
});

describe('readReorderFacts (DEV-678)', () => {
  it('reads one tenant- and branch-scoped SQL statement and normalizes its numbers', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        medicineId: 'med_a',
        medicineName: 'Alpha',
        soldUnits: BigInt(56),
        onHandUnits: BigInt(-4),
        inboundUnits: null,
        supplierId: 'sup_a',
        supplierName: 'Karachi Distributors',
        supplierActive: true,
        packLevelId: 'pack_a',
        canonicalUnitsPerPack: 10,
        listPricePerPackMinor: 1_000,
        discountBps: null,
        taxBps: null,
        taxCreditable: null,
        lineLeadTimeDays: null,
        observedLeadTimeDays: 4,
      },
    ]);
    const readAt = new Date('2026-11-15T00:00:00.000Z');
    const facts = await readReorderFacts(
      { $queryRaw: queryRaw } as unknown as ScopedDb,
      { organizationId: 'org_a', branchId: 'branch_a' },
      policy,
      readAt
    );
    expect(facts).toEqual([
      expect.objectContaining({
        soldUnits: 56,
        onHandUnits: 0,
        inboundUnits: 0,
        discountBps: 0,
        taxBps: 0,
        taxCreditable: false,
        observedLeadTimeDays: 4,
      }),
    ]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    expect(sql.values).toContain('org_a');
    expect(sql.values).toContain('branch_a');
    expect(sql.values).toContainEqual(new Date('2026-10-18T00:00:00.000Z'));
    expect(sql.sql).toContain("s.status='COMPLETED'");
    expect(sql.sql).toContain("sb.disposition='AVAILABLE'");
    // Cover counts only stock the counter could sell, net of reservations.
    expect(sql.sql).toContain("b.state='ACTIVE'");
    expect(sql.sql).toContain('b."expiresAt">?');
    expect(sql.sql).toContain('lot."receivedAt" IS NOT NULL');
    expect(sql.sql).toContain('pharmacy_supplier_claims');
    expect(sql.sql).toContain('pharmacy_restock_reservations');
    expect(sql.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('refuses an unbounded read', async () => {
    const queryRaw = vi.fn().mockResolvedValue(new Array(5_001).fill({}));
    await expect(
      readReorderFacts(
        { $queryRaw: queryRaw } as unknown as ScopedDb,
        { organizationId: 'org_a', branchId: 'branch_a' },
        policy
      )
    ).rejects.toThrow(RangeError);
  });
});
