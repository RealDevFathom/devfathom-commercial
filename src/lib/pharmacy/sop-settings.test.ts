/**
 * DEV-751 — per-branch automatic scheduling. The settings model is mocked as an
 * in-memory append-only table (newest row per branch wins, no row = OFF) and the
 * engine generator is mocked, so this suite pins: default OFF, idempotent
 * appends, which branches the hourly job fans out to (active sites whose latest
 * setting is ON), and that per-branch generation re-reads the site and setting
 * and reaches the engine for that one engine branch only, never back-dated, on
 * the caller's db.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ generateDueSopOccurrences: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/sop-occurrence-generation', () => ({
  generateDueSopOccurrences: engine.generateDueSopOccurrences,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  PHARMACY_SOP_AUTO_SCHEDULE_DEFAULT,
  generateAutoPharmacySopBranchOccurrences,
  pharmacySopAutoSchedule,
  pharmacySopAutoScheduledBranchIds,
  setPharmacySopAutoSchedule,
} from './sop-settings';

type Row = {
  id: string;
  pharmacyBranchId: string;
  autoScheduleEnabled: boolean;
  changedByUserId: string;
  reason: string | null;
  createdAt: Date;
};

function makeDb(opts: {
  sites?: Array<{ pharmacyBranchId: string; sopBranchId: string }>;
  rows?: Row[];
}) {
  const rows: Row[] = [...(opts.rows ?? [])];
  let clock = Date.parse('2026-11-04T09:00:00.000Z');
  const newestFirst = (a: Row, b: Row) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
  const raw = {
    pharmacySopSite: {
      findMany: vi.fn(async () => opts.sites ?? []),
      findFirst: vi.fn(
        async ({ where }: { where: { pharmacyBranchId: string } }) =>
          (opts.sites ?? []).find((site) => site.pharmacyBranchId === where.pharmacyBranchId) ??
          null
      ),
    },
    pharmacySopSiteSetting: {
      findFirst: vi.fn(async ({ where }: { where: { pharmacyBranchId: string } }) => {
        const match = rows.filter((row) => row.pharmacyBranchId === where.pharmacyBranchId);
        return match.sort(newestFirst)[0] ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: { pharmacyBranchId: { in: string[] } } }) =>
        rows
          .filter((row) => where.pharmacyBranchId.in.includes(row.pharmacyBranchId))
          .sort(newestFirst)
      ),
      create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
        clock += 1000;
        const row: Row = { ...data, id: `set_${rows.length + 1}`, createdAt: new Date(clock) };
        rows.push(row);
        return row;
      }),
      update: vi.fn(),
      delete: vi.fn(),
      upsert: vi.fn(),
    },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(raw)),
  };
  return { db: raw as unknown as ScopedDb, raw, rows };
}

const at = (iso: string) => new Date(iso);
const row = (
  id: string,
  pharmacyBranchId: string,
  autoScheduleEnabled: boolean,
  createdAt: string
): Row => ({
  id,
  pharmacyBranchId,
  autoScheduleEnabled,
  changedByUserId: 'user_mgr',
  reason: null,
  createdAt: at(createdAt),
});

beforeEach(() => {
  vi.clearAllMocks();
  engine.generateDueSopOccurrences.mockResolvedValue({
    assignmentsProcessed: 2,
    created: 3,
    skipped: 0,
  });
});

describe('pharmacySopAutoSchedule', () => {
  it('is OFF when the branch has no setting row', async () => {
    expect(PHARMACY_SOP_AUTO_SCHEDULE_DEFAULT).toBe(false);
    const { db } = makeDb({});
    await expect(pharmacySopAutoSchedule(db, { pharmacyBranchId: 'pb_1' })).resolves.toEqual({
      pharmacyBranchId: 'pb_1',
      autoScheduleEnabled: false,
      changedByUserId: null,
      reason: null,
      changedAt: null,
    });
  });

  it('reads the newest row for that branch only', async () => {
    const { db, raw } = makeDb({
      rows: [
        row('s1', 'pb_1', true, '2026-11-01T00:00:00.000Z'),
        row('s2', 'pb_1', false, '2026-11-02T00:00:00.000Z'),
        row('s3', 'pb_2', true, '2026-11-03T00:00:00.000Z'),
      ],
    });
    const setting = await pharmacySopAutoSchedule(db, { pharmacyBranchId: 'pb_1' });
    expect(setting.autoScheduleEnabled).toBe(false);
    expect(setting.changedAt).toEqual(at('2026-11-02T00:00:00.000Z'));
    expect(raw.pharmacySopSiteSetting.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pharmacyBranchId: 'pb_1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
    );
  });
});

describe('setPharmacySopAutoSchedule', () => {
  const site = { pharmacyBranchId: 'pb_1' };

  it('appends a row with who changed it and why', async () => {
    const { db, rows, raw } = makeDb({});
    const result = await setPharmacySopAutoSchedule(db, {
      site,
      enabled: true,
      userId: 'user_mgr',
      reason: '  Team agreed  ',
    });
    expect(result.changed).toBe(true);
    expect(result.setting).toMatchObject({
      pharmacyBranchId: 'pb_1',
      autoScheduleEnabled: true,
      changedByUserId: 'user_mgr',
      reason: 'Team agreed',
    });
    expect(rows).toHaveLength(1);
    // Serialized per branch; never updates or deletes history.
    expect(raw.$queryRaw).toHaveBeenCalledTimes(1);
    expect(raw.pharmacySopSiteSetting.update).not.toHaveBeenCalled();
    expect(raw.pharmacySopSiteSetting.delete).not.toHaveBeenCalled();
    expect(raw.pharmacySopSiteSetting.upsert).not.toHaveBeenCalled();
  });

  it('is idempotent: no new row when the value is unchanged (including the OFF default)', async () => {
    const { db, rows, raw } = makeDb({});
    const off = await setPharmacySopAutoSchedule(db, { site, enabled: false, userId: 'u' });
    expect(off.changed).toBe(false);
    expect(rows).toHaveLength(0);

    await setPharmacySopAutoSchedule(db, { site, enabled: true, userId: 'u' });
    const again = await setPharmacySopAutoSchedule(db, { site, enabled: true, userId: 'u' });
    expect(again.changed).toBe(false);
    expect(rows).toHaveLength(1);

    const back = await setPharmacySopAutoSchedule(db, { site, enabled: false, userId: 'u' });
    expect(back.changed).toBe(true);
    expect(rows.map((entry) => entry.autoScheduleEnabled)).toEqual([true, false]);
    expect(raw.pharmacySopSiteSetting.create).toHaveBeenCalledTimes(2);
  });

  it('stores an empty reason as null and refuses an over-long one', async () => {
    const { db, rows } = makeDb({});
    await setPharmacySopAutoSchedule(db, { site, enabled: true, userId: 'u', reason: '   ' });
    expect(rows[0]!.reason).toBeNull();
    await expect(
      setPharmacySopAutoSchedule(db, { site, enabled: false, userId: 'u', reason: 'x'.repeat(501) })
    ).rejects.toThrow(RangeError);
    expect(rows).toHaveLength(1);
  });
});

describe('automatic scheduling reads and per-branch generation', () => {
  const sites = [
    { pharmacyBranchId: 'pb_on', sopBranchId: 'sop_on' },
    { pharmacyBranchId: 'pb_off', sopBranchId: 'sop_off' },
    { pharmacyBranchId: 'pb_never', sopBranchId: 'sop_never' },
    { pharmacyBranchId: 'pb_reoff', sopBranchId: 'sop_reoff' },
  ];
  const rows = [
    row('a', 'pb_on', true, '2026-11-01T00:00:00.000Z'),
    row('b', 'pb_off', false, '2026-11-01T00:00:00.000Z'),
    row('c', 'pb_reoff', true, '2026-11-01T00:00:00.000Z'),
    row('d', 'pb_reoff', false, '2026-11-02T00:00:00.000Z'),
  ];
  const now = at('2026-11-04T06:00:00.000Z');

  it('lists only active sites whose latest setting is ON', async () => {
    const { db, raw } = makeDb({ sites, rows });
    await expect(pharmacySopAutoScheduledBranchIds(db)).resolves.toEqual(['pb_on']);
    expect(raw.pharmacySopSite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pharmacyBranch: { active: true } } })
    );
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });

  it('lists nothing by default, and reads no setting without a site', async () => {
    await expect(pharmacySopAutoScheduledBranchIds(makeDb({ sites }).db)).resolves.toEqual([]);
    const empty = makeDb({});
    await expect(pharmacySopAutoScheduledBranchIds(empty.db)).resolves.toEqual([]);
    expect(empty.raw.pharmacySopSiteSetting.findMany).not.toHaveBeenCalled();
  });

  it('generates one ON branch, restricted to its engine branch, never back-dated', async () => {
    const { db, raw } = makeDb({ sites, rows });
    await expect(
      generateAutoPharmacySopBranchOccurrences(db, { pharmacyBranchId: 'pb_on', now })
    ).resolves.toEqual({ assignmentsProcessed: 2, created: 3, skipped: 0 });
    // Nothing due before a schedule existed, or before the branch turned ON.
    expect(engine.generateDueSopOccurrences).toHaveBeenCalledExactlyOnceWith(db, {
      now,
      branchIds: ['sop_on'],
      lookbackDays: 0,
      skipDueBeforeAssignmentCreated: true,
      skipDueBefore: new Date('2026-11-01T00:00:00.000Z'),
    });
    // The site is re-read on the active pharmacy branch.
    expect(raw.pharmacySopSite.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { pharmacyBranchId: 'pb_on', pharmacyBranch: { active: true } },
      })
    );
  });

  it('does nothing for a branch that is OFF, never set, re-OFF or without a site', async () => {
    const { db } = makeDb({ sites, rows });
    for (const pharmacyBranchId of ['pb_off', 'pb_never', 'pb_reoff', 'pb_missing']) {
      await expect(
        generateAutoPharmacySopBranchOccurrences(db, { pharmacyBranchId, now })
      ).resolves.toBeNull();
    }
    expect(engine.generateDueSopOccurrences).not.toHaveBeenCalled();
  });

  it('lets a generation error propagate to the job', async () => {
    const { db } = makeDb({ sites, rows });
    engine.generateDueSopOccurrences.mockRejectedValueOnce(new Error('bad assignment'));
    await expect(
      generateAutoPharmacySopBranchOccurrences(db, { pharmacyBranchId: 'pb_on', now })
    ).rejects.toThrow('bad assignment');
  });
});
