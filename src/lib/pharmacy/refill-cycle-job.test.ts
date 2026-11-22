import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(),
  withTenantDb: vi.fn(),
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({})),
}));
vi.mock('./customer-ordering', () => ({ activateBranchScope: vi.fn(async () => undefined) }));
vi.mock('./refill-subscriptions', async (original) => ({
  ...(await original<typeof import('./refill-subscriptions')>()),
  openRefillCycle: vi.fn(),
}));

import { hasModule } from '@/lib/entitlements';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

import { processDueRefillSubscriptionCycles } from './refill-cycle-job';
import { refillCycleOpensBy, refillSubscriptionReminder } from './refill-subscription-rules';
import { openRefillCycle, RefillSubscriptionError } from './refill-subscriptions';

const DAY = 86_400_000;
const NOW = new Date('2026-12-01T20:00:00.000Z'); // 2 Dec 01:00 in Asia/Karachi

type Row = {
  id: string;
  organizationId: string;
  branchId: string;
  nextDueAt: Date;
  reminderLeadDays: number;
  createdByUserId: string;
  timezone: string | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'sub-1',
    organizationId: 'org-1',
    branchId: 'branch-1',
    nextDueAt: new Date(NOW.getTime() + 2 * DAY),
    reminderLeadDays: 3,
    createdByUserId: 'owner-1',
    timezone: 'Asia/Karachi',
    ...overrides,
  };
}

/**
 * A stateful stand-in for the database: the platform scan returns `scan`, and each
 * tenant transaction sees the subscription's live `nextDueAt` under its row lock.
 */
function harness(scan: Row[], pages?: Row[][]) {
  const all = pages ? pages.flat() : scan;
  const live = new Map(all.map((item) => [item.id, { ...item, status: 'ACTIVE' }]));
  const queue = pages ? [...pages] : null;
  const audits: unknown[] = [];
  const tenantCalls: Array<{ organizationId: string; userId?: string }> = [];
  vi.mocked(withPlatformDb).mockImplementation(async (run) =>
    run({ $queryRaw: vi.fn(async () => (queue ? (queue.shift() ?? []) : scan)) } as never)
  );
  vi.mocked(withTenantDb).mockImplementation(async (organizationId, run, options) => {
    tenantCalls.push({ organizationId, userId: options?.userId });
    const db = {
      $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
        const id = query.values?.[2] as string;
        const current = live.get(id);
        return current ? [{ nextDueAt: current.nextDueAt, status: current.status }] : [];
      }),
      auditLog: { create: vi.fn(async (input: unknown) => audits.push(input)) },
    };
    return run(db as never);
  });
  vi.mocked(openRefillCycle).mockImplementation(async (_db, _scope, subscriptionId) => {
    const current = live.get(subscriptionId)!;
    const cycle = {
      id: `cycle-${subscriptionId}-${current.nextDueAt.toISOString()}`,
      dueAt: current.nextDueAt,
      status: 'AWAITING_PHARMACIST',
      requiresPharmacist: true,
    };
    current.nextDueAt = new Date(current.nextDueAt.getTime() + 30 * DAY);
    return cycle as never;
  });
  return { live, audits, tenantCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
});

describe('DEV-73 scheduled job: opening due refill cycles', () => {
  it('opens a due cycle once, even when a second run scans the same due date', async () => {
    const scanned = row();
    const { audits } = harness([scanned]);

    await expect(processDueRefillSubscriptionCycles(NOW)).resolves.toMatchObject({
      opened: 1,
      alreadyOpened: 0,
    });
    // A concurrent or repeated run that read the scan before the first committed.
    await expect(processDueRefillSubscriptionCycles(NOW)).resolves.toMatchObject({
      opened: 0,
      alreadyOpened: 1,
    });
    expect(openRefillCycle).toHaveBeenCalledTimes(1);
    expect(audits).toEqual([
      {
        data: expect.objectContaining({
          actorType: 'SYSTEM',
          source: 'SYSTEM',
          action: 'pharmacy.refillCycle.scheduledOpen',
          metadata: expect.objectContaining({ subscriptionId: 'sub-1', requiresPharmacist: true }),
        }),
      },
    ]);
  });

  it("opens on the organization's own day, not the UTC day", async () => {
    // Opening day starts 07:00 on 2 Dec in Karachi; there it is already 2 Dec at 01:00.
    const nextDueAt = new Date('2026-12-05T02:00:00.000Z');
    harness([
      row({ nextDueAt, timezone: 'Asia/Karachi' }),
      row({ id: 'sub-utc', nextDueAt, timezone: 'UTC' }),
    ]);

    const result = await processDueRefillSubscriptionCycles(NOW);

    expect(result).toMatchObject({ scanned: 2, opened: 1, notDue: 1 });
    expect(openRefillCycle).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', branchId: 'branch-1', actorId: 'owner-1' },
      'sub-1'
    );
    expect(refillCycleOpensBy({ nextDueAt, reminderLeadDays: 3 }, 'Asia/Karachi', NOW)).toBe(true);
    expect(refillCycleOpensBy({ nextDueAt, reminderLeadDays: 3 }, 'UTC', NOW)).toBe(false);
  });

  it('runs each subscription in its own tenant transaction as its creator', async () => {
    const { tenantCalls } = harness([
      row(),
      row({ id: 'sub-2', organizationId: 'org-2', createdByUserId: 'owner-2' }),
    ]);
    await processDueRefillSubscriptionCycles(NOW);
    expect(tenantCalls).toEqual([
      { organizationId: 'org-1', userId: 'owner-1' },
      { organizationId: 'org-2', userId: 'owner-2' },
    ]);
  });

  it('keeps going past a stock-out or a failure, and opens nothing for an unlicensed organization', async () => {
    harness([row({ id: 'sub-out' }), row({ id: 'sub-broken' }), row({ id: 'sub-ok' })]);
    vi.mocked(openRefillCycle)
      .mockRejectedValueOnce(new RefillSubscriptionError('INSUFFICIENT_STOCK'))
      .mockRejectedValueOnce(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await processDueRefillSubscriptionCycles(NOW);
    expect(result).toMatchObject({ opened: 1, failed: 1, skipped: { INSUFFICIENT_STOCK: 1 } });

    vi.clearAllMocks();
    harness([row()]);
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(processDueRefillSubscriptionCycles(NOW)).resolves.toMatchObject({
      opened: 0,
      skipped: { UNLICENSED: 1 },
    });
    expect(openRefillCycle).not.toHaveBeenCalled();
  });

  it('pages past subscriptions that keep being skipped, so they never starve later ones', async () => {
    // limit 1 reads pages of 4: a full page of stock-outs, then a due subscription with stock.
    const stockOuts = [1, 2, 3, 4].map((n) => row({ id: `sub-out-${n}` }));
    harness([], [stockOuts, [row({ id: 'sub-later' })]]);
    vi.mocked(openRefillCycle).mockImplementation(async (_db, _scope, id) => {
      if (id.startsWith('sub-out')) throw new RefillSubscriptionError('INSUFFICIENT_STOCK');
      return {
        id: 'cycle-later',
        dueAt: NOW,
        status: 'RESERVED',
        requiresPharmacist: false,
      } as never;
    });

    const result = await processDueRefillSubscriptionCycles(NOW, 1);

    expect(result).toMatchObject({ scanned: 5, opened: 1, skipped: { INSUFFICIENT_STOCK: 4 } });
    expect(openRefillCycle).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'sub-later'
    );
    expect(withPlatformDb).toHaveBeenCalledTimes(2);
  });

  it('asks the entitlements of an unlicensed organization once per run', async () => {
    harness([row({ id: 'sub-a' }), row({ id: 'sub-b' }), row({ id: 'sub-c' })]);
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(processDueRefillSubscriptionCycles(NOW)).resolves.toMatchObject({
      skipped: { UNLICENSED: 3 },
    });
    expect(withTenantDb).toHaveBeenCalledTimes(1);
  });

  it('leaves a subscription whose opening day has not come', async () => {
    harness([row({ nextDueAt: new Date(NOW.getTime() + 10 * DAY) })]);
    await expect(processDueRefillSubscriptionCycles(NOW)).resolves.toMatchObject({
      opened: 0,
      notDue: 1,
    });
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it('sends a reminder for the opened cycle that never names the medicine', async () => {
    const { live } = harness([row()]);
    const dueAt = live.get('sub-1')!.nextDueAt;
    await processDueRefillSubscriptionCycles(NOW);
    const reminder = refillSubscriptionReminder({ id: 'cycle-sub-1', dueAt });
    const text = JSON.stringify(reminder).toLowerCase();
    for (const word of ['metformin', 'tablet', 'mg', 'insulin', 'diabetes', 'medicine'])
      expect(text).not.toContain(word);
    expect(reminder.parameters).toEqual([dueAt.toISOString().slice(0, 10)]);
  });
});

it('names a subscription due at 00:30 on the Karachi calendar', () => {
  expect(
    refillSubscriptionReminder(
      { id: 'cycle', dueAt: new Date('2026-11-02T00:30:00+05:00') },
      'Asia/Karachi'
    )
  ).toMatchObject({ dueDate: '2026-11-02', dedupeKey: 'refill-subscription:cycle' });
});
