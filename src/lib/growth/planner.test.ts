import { describe, it, expect, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { guardProposals, runWeeklyPlanner } from './planner';
import { plannerSignals, revenueByWeekday } from './signals';
import { calendar, outsideQuietHours, weekStart } from './calendar';
vi.mock('./codes', () => ({ lockGrowth: vi.fn() }));
const now = new Date('2026-10-26T05:00:00Z');
const settings = {
  quietHoursStart: 21,
  quietHoursEnd: 9,
  maxDiscountPct: 15,
  autoApproveUnderMinor: 100,
  monthlyBudgetMinor: 1000,
  customDates: [],
  lastPlanRunAt: null,
};
const templates = [
  { id: 'template', key: 'generic', body: 'Salaam {{name}}. {{discount}}. Reply STOP to opt out.' },
  {
    id: 'refill',
    key: 'refill_reminder',
    body: 'Your refill reminder. Contact the shop. Reply STOP to opt out.',
  },
];
const proposal = {
  kind: 'manual',
  name: 'Retail visit',
  segment: { type: 'all' },
  sendAt: '2026-10-26T17:00:00Z',
  discountType: 'percent',
  discountValue: 50,
  budgetCapMinor: 5000,
  templateKey: 'generic',
  rationale: 'A quiet day',
};
describe('weekly planner', () => {
  it('drops invalid segments and clamps discount, budget, and quiet hours', () => {
    const rows = guardProposals(
      { proposals: [{ ...proposal, segment: { type: 'invented' } }, proposal] },
      settings,
      1000,
      10000,
      templates,
      [],
      now
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      discountValue: 15,
      budgetCapMinor: 1000,
      status: 'proposed',
      sendAt: new Date('2026-10-27T04:00:00Z'),
    });
  });
  it('reserves budget across proposals, caps fixed discounts, and auto approves strictly below threshold', () => {
    const rows = guardProposals(
      {
        proposals: [
          { ...proposal, discountType: 'fixed', discountValue: 9999, budgetCapMinor: 50 },
          { ...proposal, kind: 'holiday', budgetCapMinor: 10000 },
        ],
      },
      settings,
      1000,
      10000,
      templates,
      [],
      now
    );
    expect(rows.map((r) => r.budgetCapMinor)).toEqual([50, 950]);
    expect(rows[0]).toMatchObject({ discountValue: 1500, status: 'approved' });
  });
  it('rejects unlisted templates, duplicate segments regardless of key order, and sends outside the window', () => {
    expect(
      guardProposals(
        {
          proposals: [
            proposal,
            { ...proposal, templateKey: 'bad' },
            { ...proposal, sendAt: '2027-01-01T12:00:00Z' },
          ],
        },
        settings,
        1000,
        10000,
        templates,
        [{ kind: 'manual', segment: { type: 'all' }, sendAt: new Date('2026-10-28T04:00:00Z') }],
        now
      )
    ).toEqual([]);
  });
  it('keeps refills utility only', () => {
    const refill = {
      ...proposal,
      kind: 'refill',
      segment: { type: 'refill_due', withinDays: 3 },
      templateKey: 'refill_reminder',
    };
    expect(
      guardProposals({ proposals: [refill] }, settings, 1000, 10000, templates, [], now)
    ).toEqual([]);
    expect(
      guardProposals(
        { proposals: [{ ...refill, discountType: 'none', discountValue: 0 }] },
        settings,
        1000,
        10000,
        templates,
        [],
        now
      )
    ).toHaveLength(1);
  });
  it('runs once per local week on scheduler retries', async () => {
    const saved = { ...settings } as typeof settings & { lastPlanRunAt: Date | null };
    const db = {
      $queryRaw: vi.fn(async () => [{ start: new Date('2026-09-30T19:00:00Z') }]),
      growthSettings: {
        findUnique: vi.fn(async () => saved),
        update: vi.fn(async ({ data }) => Object.assign(saved, data)),
      },
      pharmacySale: { findMany: vi.fn(async () => []) },
      pharmacyCustomer: { findMany: vi.fn(async () => []) },
      campaignRecipient: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
      campaign: { findMany: vi.fn(async () => []), create: vi.fn() },
      messageTemplate: { findMany: vi.fn(async () => templates) },
      auditLog: { create: vi.fn() },
    };
    const generate = vi.fn(async () => ({ proposals: [proposal] }));
    expect(await runWeeklyPlanner(db as unknown as ScopedDb, 'org', now, generate)).toBe(1);
    expect(await runWeeklyPlanner(db as unknown as ScopedDb, 'org', now, generate)).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(db.campaign.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org',
          createdBy: 'ai',
          status: 'proposed',
        }),
      })
    );
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it('skips other weekdays', async () => {
    const generate = vi.fn();
    expect(
      await runWeeklyPlanner({} as ScopedDb, 'org', new Date('2026-10-27T05:00:00Z'), generate)
    ).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });
});
it('computes slow weekdays from eight weeks of revenue, including zero revenue days', () => {
  const sales = Array.from({ length: 56 }, (_, i) => ({
    completedAt: new Date(Date.UTC(2026, 7, 3 + i, 7)),
    lines: [{ quantity: 1, unitPriceMinor: i % 7 === 0 ? 40 : 100, discountMinor: 0 }],
  }));
  const result = revenueByWeekday(sales);
  expect(result.filter((r) => r.slow).map((r) => r.weekday)).toEqual([1]);
  expect(result[1].revenueMinor).toBe(320);
  expect(revenueByWeekday([]).some((r) => r.slow)).toBe(false);
});
it('uses local weeks, editable holidays, and overnight and daytime quiet windows', () => {
  expect(weekStart(new Date('2026-10-25T20:00:00Z'))).toEqual(new Date('2026-10-25T19:00:00Z'));
  expect(
    calendar(now, [{ date: '2026-10-27', name: 'Shop anniversary' }])[1].holidays[0].name
  ).toBe('Shop anniversary');
  expect(outsideQuietHours(new Date('2026-10-26T08:00:00Z'), 12, 15)).toEqual(
    new Date('2026-10-26T10:00:00Z')
  );
});

it('computes tenant-scoped segment, spend, basket, and redemption signals without sending identities to the model', async () => {
  const customer = {
    patient: { dateOfBirth: new Date('2000-11-01T00:00:00Z') },
    growthMetrics: { churnBand: 'high', nextRefillDueAt: new Date('2026-10-28T00:00:00Z') },
  };
  const db = {
    $queryRaw: vi.fn(async () => [{ start: new Date('2026-09-30T19:00:00Z') }]),
    pharmacySale: {
      findMany: vi.fn(async () => [
        { completedAt: now, lines: [{ quantity: 2, unitPriceMinor: 1000, discountMinor: 100 }] },
      ]),
    },
    pharmacyCustomer: {
      findMany: vi.fn(async () => [
        customer,
        {
          patient: { dateOfBirth: null },
          growthMetrics: { churnBand: 'medium', nextRefillDueAt: null },
        },
      ]),
    },
    campaign: {
      findMany: vi.fn(async () => [
        { kind: 'holiday', estimatedReach: 100, spentMinor: 300, _count: { recipients: 10 } },
      ]),
    },
    campaignRecipient: {
      count: vi.fn().mockResolvedValueOnce(100).mockResolvedValueOnce(10),
      findMany: vi.fn(async () => [{ sale: { lines: [{ discountMinor: 300 }] } }]),
    },
  };
  const result = await plannerSignals(db as unknown as ScopedDb, 'org', now, settings);
  expect(result).toMatchObject({
    remainingBudgetMinor: 700,
    averageBasketMinor: 1900,
    redemptionRate: 0.1,
    segments: { high: 1, medium: 1, birthdays: 1, refillDue: 1, optedIn: 2 },
  });
  for (const table of [db.pharmacySale, db.pharmacyCustomer, db.campaign, db.campaignRecipient])
    expect(table.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org' }) })
    );
  expect(JSON.stringify(result)).not.toContain('dateOfBirth');
});
