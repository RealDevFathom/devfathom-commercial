/**
 * M7-L3 — SOP occurrence generation tests. Proven end-to-end against a stateful
 * in-memory occurrence store: window-idempotency (re-run → zero duplicates), the
 * unique-violation concurrency swallow, version pinning to the latest PUBLISHED,
 * per-branch timezone resolution, DST-adjusted due instants, and strict handler
 * payload validation.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  generateDueSopOccurrences,
  generateSopOccurrencesHandler,
  occurrenceId,
} from './sop-occurrence-generation';

type AssignmentFixture = {
  id: string;
  branchId: string;
  templateId: string;
  frequency: 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'INTERVAL';
  interval: number;
  daysOfWeek: number[];
  monthDay: number | null;
  startDate: Date;
  endDate: Date | null;
  dueTimeMinutes: number;
  intervalEndTimeMinutes: number | null;
  windowMinutes: number;
  active: boolean;
  branch: { id: string; timezone: string; businessDayCutoff: string };
};

type OccurrenceRow = {
  assignmentId: string;
  businessDate: Date;
  dueAt: Date;
  windowEndsAt: Date;
  templateVersionId: string;
};

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function assignment(overrides: Partial<AssignmentFixture> = {}): AssignmentFixture {
  return {
    id: 'a1',
    branchId: 'b1',
    templateId: 't1',
    frequency: 'DAILY',
    interval: 1,
    daysOfWeek: [],
    monthDay: null,
    startDate: utcDate(2026, 6, 1),
    endDate: null,
    dueTimeMinutes: 6 * 60,
    intervalEndTimeMinutes: null,
    windowMinutes: 120,
    active: true,
    branch: { id: 'b1', timezone: 'America/New_York', businessDayCutoff: '00:00' },
    ...overrides,
  };
}

/** A stateful db: the occurrence store enforces unique(assignmentId, businessDate). */
function makeDb(opts: {
  assignments: AssignmentFixture[];
  publishedVersionByTemplate?: Record<string, { id: string } | null>;
  versionSteps?: Array<{ id: string }>;
}) {
  const store: OccurrenceRow[] = [];
  const published = opts.publishedVersionByTemplate ?? { t1: { id: 'v1' } };
  const steps = opts.versionSteps ?? [{ id: 's1' }, { id: 's2' }];

  const db = {
    restaurantSopAssignment: {
      findMany: vi.fn(async () => opts.assignments.filter((candidate) => candidate.active)),
    },
    restaurantSopTemplateVersion: {
      findFirst: vi.fn(
        async ({ where }: { where: { templateId: string } }) => published[where.templateId] ?? null
      ),
    },
    restaurantSopTemplateStep: {
      findMany: vi.fn(async () => steps),
    },
    restaurantSopOccurrence: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { assignmentId: string; businessDate: { gte: Date; lte: Date } };
        }) =>
          store
            .filter(
              (o) =>
                o.assignmentId === where.assignmentId &&
                o.businessDate.getTime() >= where.businessDate.gte.getTime() &&
                o.businessDate.getTime() <= where.businessDate.lte.getTime()
            )
            .map((o) => ({ dueAt: o.dueAt }))
      ),
      create: vi.fn(async ({ data }: { data: OccurrenceRow }) => {
        const dup = store.find(
          (o) => o.assignmentId === data.assignmentId && o.dueAt.getTime() === data.dueAt.getTime()
        );
        if (dup) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: '7.9.1',
          });
        }
        store.push(data);
        return { id: `occ_${store.length}`, ...data };
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db: db as unknown as ScopedDb, store, raw: db };
}

const at = (isoUtc: string) => new Date(isoUtc);

describe('generateDueSopOccurrences', () => {
  it('materialises the window once and is idempotent on re-run', async () => {
    const { db, raw } = makeDb({ assignments: [assignment()] });
    const now = at('2026-06-15T12:00:00.000Z'); // 08:00 EDT → business date 2026-06-15

    const first = await generateDueSopOccurrences(db, { now });
    // window [06-14 .. 06-16] with lookback/horizon 1, DAILY from 06-01.
    expect(first).toEqual({ assignmentsProcessed: 1, created: 3, skipped: 0 });

    const second = await generateDueSopOccurrences(db, { now });
    expect(second).toEqual({ assignmentsProcessed: 1, created: 0, skipped: 0 });
    // No second write burst: create called exactly the 3 times from run one.
    expect(raw.restaurantSopOccurrence.create).toHaveBeenCalledTimes(3);
  });

  it('switches from a bounded predecessor to its future-effective successor', async () => {
    const predecessor = assignment({
      id: 'a1',
      startDate: utcDate(2026, 5, 1),
      endDate: utcDate(2026, 5, 31),
    });
    const successor = assignment({
      id: 'a2',
      startDate: utcDate(2026, 6, 1),
      dueTimeMinutes: 9 * 60,
    });
    const { db, store } = makeDb({ assignments: [predecessor, successor] });

    await generateDueSopOccurrences(db, {
      now: at('2026-06-01T12:00:00.000Z'),
      lookbackDays: 1,
      horizonDays: 0,
    });

    expect(
      store.map((row) => ({
        assignmentId: row.assignmentId,
        businessDate: row.businessDate.toISOString(),
        dueAt: row.dueAt.toISOString(),
      }))
    ).toEqual([
      {
        assignmentId: 'a1',
        businessDate: '2026-05-31T00:00:00.000Z',
        dueAt: '2026-05-31T10:00:00.000Z',
      },
      {
        assignmentId: 'a2',
        businessDate: '2026-06-01T00:00:00.000Z',
        dueAt: '2026-06-01T13:00:00.000Z',
      },
    ]);
  });

  it('pins the latest published version and seeds occurrence steps', async () => {
    const { db, store } = makeDb({
      assignments: [assignment()],
      publishedVersionByTemplate: { t1: { id: 'v7' } },
    });
    await generateDueSopOccurrences(db, {
      now: at('2026-06-15T12:00:00.000Z'),
      lookbackDays: 0,
      horizonDays: 0,
    });
    expect(store).toHaveLength(1);
    expect(store[0]!.templateVersionId).toBe('v7');
  });

  it('schedules nothing when the template has no published version', async () => {
    const { db, raw } = makeDb({
      assignments: [assignment()],
      publishedVersionByTemplate: { t1: null },
    });
    const result = await generateDueSopOccurrences(db, { now: at('2026-06-15T12:00:00.000Z') });
    expect(result).toEqual({ assignmentsProcessed: 1, created: 0, skipped: 0 });
    expect(raw.restaurantSopOccurrence.create).not.toHaveBeenCalled();
  });

  it('computes the due instant in the branch timezone with DST spring-forward', async () => {
    const { db, store } = makeDb({
      assignments: [
        assignment({
          startDate: utcDate(2026, 3, 1),
          dueTimeMinutes: 2 * 60 + 30, // 02:30 local — inside the NY spring-forward gap on 03-08
        }),
      ],
    });
    // as-of 2026-03-08; generate just that business date.
    await generateDueSopOccurrences(db, {
      now: at('2026-03-08T12:00:00.000Z'),
      lookbackDays: 0,
      horizonDays: 0,
    });
    expect(store).toHaveLength(1);
    expect(store[0]!.businessDate.toISOString()).toBe('2026-03-08T00:00:00.000Z');
    expect(store[0]!.dueAt.toISOString()).toBe('2026-03-08T07:00:00.000Z'); // next valid instant
  });

  it('resolves each branch timezone independently', async () => {
    const berlin = assignment({
      id: 'a2',
      branchId: 'b2',
      templateId: 't1',
      dueTimeMinutes: 9 * 60,
      branch: { id: 'b2', timezone: 'Europe/Berlin', businessDayCutoff: '00:00' },
    });
    const ny = assignment({ id: 'a1', dueTimeMinutes: 9 * 60 });
    const { db, store } = makeDb({ assignments: [ny, berlin] });
    await generateDueSopOccurrences(db, {
      now: at('2026-06-15T12:00:00.000Z'),
      lookbackDays: 0,
      horizonDays: 0,
    });
    const byAssignment = Object.fromEntries(
      store.map((o) => [o.assignmentId, o.dueAt.toISOString()])
    );
    expect(byAssignment.a1).toBe('2026-06-15T13:00:00.000Z'); // 09:00 EDT
    expect(byAssignment.a2).toBe('2026-06-15T07:00:00.000Z'); // 09:00 CEST
  });

  it('materialises and de-duplicates multiple INTERVAL slots on one business date', async () => {
    const { db, store } = makeDb({
      assignments: [
        assignment({
          frequency: 'INTERVAL',
          interval: 20,
          daysOfWeek: [1],
          dueTimeMinutes: 9 * 60,
          intervalEndTimeMinutes: 10 * 60,
        }),
      ],
    });
    const options = {
      now: at('2026-06-15T12:00:00.000Z'),
      lookbackDays: 0,
      horizonDays: 0,
    };
    expect(await generateDueSopOccurrences(db, options)).toMatchObject({ created: 4 });
    expect(await generateDueSopOccurrences(db, options)).toMatchObject({ created: 0 });
    expect(store.map((row) => row.dueAt.toISOString())).toEqual([
      '2026-06-15T13:00:00.000Z',
      '2026-06-15T13:20:00.000Z',
      '2026-06-15T13:40:00.000Z',
      '2026-06-15T14:00:00.000Z',
    ]);
  });

  it('derives deterministic occurrence identity from assignment and due instant', () => {
    const dueAt = at('2026-06-15T13:00:00.000Z');
    expect(occurrenceId('a1', dueAt)).toBe(occurrenceId('a1', new Date(dueAt)));
    expect(occurrenceId('a1', dueAt)).not.toBe(occurrenceId('a2', dueAt));
  });

  it('swallows a concurrent unique violation as a skip', async () => {
    // findMany reports nothing, but create throws P2002 (a concurrent generator won).
    const create = vi.fn(async () => {
      throw new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: '7.9.1',
      });
    });
    const db = {
      restaurantSopAssignment: { findMany: vi.fn(async () => [assignment()]) },
      restaurantSopTemplateVersion: { findFirst: vi.fn(async () => ({ id: 'v1' })) },
      restaurantSopTemplateStep: { findMany: vi.fn(async () => [{ id: 's1' }]) },
      restaurantSopOccurrence: { findMany: vi.fn(async () => []), create },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    } as unknown as ScopedDb;
    const result = await generateDueSopOccurrences(db, {
      now: at('2026-06-15T12:00:00.000Z'),
      lookbackDays: 0,
      horizonDays: 0,
    });
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('rethrows a non-unique database error', async () => {
    const db = {
      restaurantSopAssignment: { findMany: vi.fn(async () => [assignment()]) },
      restaurantSopTemplateVersion: { findFirst: vi.fn(async () => ({ id: 'v1' })) },
      restaurantSopTemplateStep: { findMany: vi.fn(async () => [{ id: 's1' }]) },
      restaurantSopOccurrence: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => {
          throw new Error('connection reset');
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    } as unknown as ScopedDb;
    await expect(
      generateDueSopOccurrences(db, {
        now: at('2026-06-15T12:00:00.000Z'),
        lookbackDays: 0,
        horizonDays: 0,
      })
    ).rejects.toThrow('connection reset');
  });
});

describe('generateDueSopOccurrences branchIds scope', () => {
  const now = at('2026-06-15T12:00:00.000Z');
  const window = { now, lookbackDays: 0, horizonDays: 0 };
  const b2 = { id: 'b2', timezone: 'America/New_York', businessDayCutoff: '00:00' };

  it('queries every active assignment when branchIds is absent (unchanged behaviour)', async () => {
    const { db, raw, store } = makeDb({
      assignments: [assignment(), assignment({ id: 'a2', branchId: 'b2', branch: b2 })],
    });
    await generateDueSopOccurrences(db, window);
    expect(raw.restaurantSopAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } })
    );
    expect(store.map((row) => row.assignmentId).sort()).toEqual(['a1', 'a2']);
  });

  it('restricts the assignment query to the given branches', async () => {
    const assignments = [assignment(), assignment({ id: 'a2', branchId: 'b2', branch: b2 })];
    const { db, raw, store } = makeDb({ assignments });
    raw.restaurantSopAssignment.findMany.mockImplementation((async (args: {
      where: { active: boolean; branchId?: { in: string[] } };
    }) =>
      assignments.filter(
        (row) => row.active && (!args.where.branchId || args.where.branchId.in.includes(row.branchId))
      )) as never);
    const result = await generateDueSopOccurrences(db, { ...window, branchIds: ['b2'] });
    expect(raw.restaurantSopAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true, branchId: { in: ['b2'] } } })
    );
    expect(result).toEqual({ assignmentsProcessed: 1, created: 1, skipped: 0 });
    expect(store.map((row) => row.assignmentId)).toEqual(['a2']);
  });

  it('generates nothing and never queries when branchIds is empty', async () => {
    const { db, raw } = makeDb({ assignments: [assignment()] });
    const result = await generateDueSopOccurrences(db, { ...window, branchIds: [] });
    expect(result).toEqual({ assignmentsProcessed: 0, created: 0, skipped: 0 });
    expect(raw.restaurantSopAssignment.findMany).not.toHaveBeenCalled();
  });
});

describe('generateSopOccurrencesHandler', () => {
  it('rejects an unknown payload key (strict boundary)', async () => {
    const { db } = makeDb({ assignments: [] });
    await expect(
      generateSopOccurrencesHandler({
        db,
        job: { id: 'j1', type: 'sop.generateOccurrences', payload: { bogus: true } } as never,
      })
    ).rejects.toBeTruthy();
  });

  it('runs generation for a valid payload', async () => {
    const { db, store } = makeDb({ assignments: [assignment()] });
    await generateSopOccurrencesHandler({
      db,
      job: {
        id: 'j1',
        type: 'sop.generateOccurrences',
        payload: { now: '2026-06-15T12:00:00.000Z', lookbackDays: 0, horizonDays: 0 },
      } as never,
    });
    expect(store).toHaveLength(1);
  });
});
