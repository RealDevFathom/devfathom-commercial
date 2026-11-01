// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.TEST_DATABASE_URL;
const at = (time: string) => new Date(`2026-09-20T${time}:00Z`);
let scope: typeof import('@/lib/tenancy/scoped-db');
let workforce: typeof import('./workforce');
let disconnect: () => Promise<void>;

type Fixture = { shiftId: string; userId: string; staffId: string; branchId: string };

async function withFixture(run: (db: ScopedDb, ids: Fixture) => Promise<void>) {
  const id = `workforce_${randomUUID().replaceAll('-', '')}`;
  const rollback = new Error('Rollback workforce fixture');
  try {
    await scope.withPlatformDb(async (db) => {
      await db.$executeRaw`
        INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt")
        VALUES (${id}, ${id}, 'Workforce test', 'Workforce test', now())`;
      await scope.withOrganizationDefaults(db, id, async (tenant) => {
        await tenant.$executeRaw`
          INSERT INTO organization_departments (id, key, name, "updatedAt")
          VALUES (${id}, 'ops', 'Operations', now())`;
        await tenant.$executeRaw`
          INSERT INTO users (id, name, email, role, department, title, "updatedAt")
          VALUES (${id}, 'Employee', ${`${id}@test.invalid`}, 'EMPLOYEE', 'ops', 'Operator', now())`;
        await tenant.$executeRaw`
          INSERT INTO restaurant_branches (id, name, "updatedAt")
          VALUES (${id}, 'Branch', now())`;
        await tenant.$executeRaw`
          INSERT INTO restaurant_staff_profiles (id, "userId", "displayName", "primaryBranchId", "updatedAt")
          VALUES (${id}, ${id}, 'Employee', ${id}, now())`;
        await tenant.$executeRaw`
          INSERT INTO restaurant_shifts
          (id, "branchId", "staffProfileId", "businessDate", "startAt", "endAt", "updatedAt")
          VALUES (${id}, ${id}, ${id}, DATE '2026-09-20', ${at('09:00')}, ${at('17:00')}, now())`;
        await run(tenant, { shiftId: id, userId: id, staffId: id, branchId: id });
      });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

function repair(ids: Fixture, kind: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_END', time: string) {
  return {
    shiftId: ids.shiftId,
    kind,
    correctedAt: at(time),
    reason: 'Reader offline',
    actorUserId: ids.userId,
    actorStaffProfileId: ids.staffId,
  };
}

async function csv(db: ScopedDb, ids: Fixture) {
  return workforce.exportWorkforceAttendanceCsv(db, {
    branchId: ids.branchId,
    fromBusinessDate: new Date('2026-09-20T00:00:00Z'),
    toBusinessDate: new Date('2026-09-20T00:00:00Z'),
  });
}

describe.skipIf(!url)('workforce punch repairs (restricted PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url!;
    scope = await import('@/lib/tenancy/scoped-db');
    workforce = await import('./workforce');
    const { db } = await import('@/lib/db');
    disconnect = () => db.$disconnect();
    const roles = await db.$queryRaw`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  afterAll(async () => {
    await disconnect?.();
  });

  it('clocks out after a missing clock-in repair without inventing a raw clock-in', async () => {
    await withFixture(async (db, ids) => {
      await workforce.appendTimeAdjustment(db, repair(ids, 'CLOCK_IN', '09:00'));
      await expect(
        workforce.clockIn(db, { ...ids, idempotencyKey: 'ci', now: at('09:05') })
      ).rejects.toMatchObject({ reason: 'CONFLICT' });
      const done = await workforce.clockOut(db, { ...ids, idempotencyKey: 'co', now: at('17:00') });
      expect(done).toMatchObject({
        clockedInAt: at('09:00'),
        clockedOutAt: at('17:00'),
        attendanceStatus: 'COMPLETE',
      });
      const replay = await workforce.clockOut(db, {
        ...ids,
        idempotencyKey: 'co',
        now: at('17:05'),
      });
      expect(replay.clockedOutAt).toEqual(at('17:00'));
      expect(
        await db.restaurantShift.findUnique({
          where: { id: ids.shiftId },
          select: { clockedInAt: true, clockedOutAt: true },
        })
      ).toEqual({ clockedInAt: null, clockedOutAt: null });
      expect((await csv(db, ids)).csv).toContain(',0,480,8.00,COMPLETE,0');
    });
  });

  it('allows another break and clock-out after an append-only missing break-end repair', async () => {
    await withFixture(async (db, ids) => {
      await workforce.clockIn(db, { ...ids, idempotencyKey: 'ci', now: at('09:00') });
      const started = await workforce.startBreak(db, {
        ...ids,
        idempotencyKey: 'b1',
        now: at('12:00'),
      });
      const breakId = started.breaks[0]!.id;
      await workforce.appendTimeAdjustment(db, { ...repair(ids, 'BREAK_END', '12:30'), breakId });
      await expect(
        workforce.endBreak(db, { ...ids, idempotencyKey: 'e1', now: at('12:35') })
      ).rejects.toMatchObject({ reason: 'CONFLICT' });
      await workforce.startBreak(db, { ...ids, idempotencyKey: 'b2', now: at('14:00') });
      await workforce.endBreak(db, { ...ids, idempotencyKey: 'e2', now: at('14:15') });
      await workforce.clockOut(db, { ...ids, idempotencyKey: 'co', now: at('17:00') });
      expect(
        await db.restaurantShiftBreak.findUnique({
          where: { id: breakId },
          select: { endedAt: true },
        })
      ).toEqual({ endedAt: null });
      expect((await csv(db, ids)).csv).toContain(',45,435,7.25,COMPLETE,0');
    });
  });

  it('prevents employee commands from changing worked time after a clock-out repair', async () => {
    await withFixture(async (db, ids) => {
      await workforce.clockIn(db, { ...ids, idempotencyKey: 'ci', now: at('09:00') });
      await workforce.appendTimeAdjustment(db, repair(ids, 'CLOCK_OUT', '17:00'));
      const before = await csv(db, ids);
      for (const command of [workforce.startBreak, workforce.endBreak, workforce.clockOut]) {
        await expect(
          command(db, { ...ids, idempotencyKey: randomUUID(), now: at('17:05') })
        ).rejects.toMatchObject({ reason: 'CONFLICT' });
      }
      expect(await csv(db, ids)).toEqual(before);
      expect(before.csv).toContain(',0,480,8.00,COMPLETE,0');
    });
  });

  it('rejects missing break targets and incomplete or contradictory completion timelines', async () => {
    await withFixture(async (db, ids) => {
      await expect(
        workforce.appendTimeAdjustment(db, repair(ids, 'CLOCK_OUT', '17:00'))
      ).rejects.toMatchObject({ reason: 'INVALID' });
      await expect(
        workforce.appendTimeAdjustment(db, {
          ...repair(ids, 'BREAK_END', '12:30'),
          breakId: 'missing',
        })
      ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
      await workforce.clockIn(db, { ...ids, idempotencyKey: 'ci', now: at('09:00') });
      await workforce.startBreak(db, { ...ids, idempotencyKey: 'b1', now: at('12:00') });
      for (const time of ['11:00', '17:00']) {
        await expect(
          workforce.appendTimeAdjustment(db, repair(ids, 'CLOCK_OUT', time))
        ).rejects.toMatchObject({ reason: 'INVALID' });
      }
      expect(await db.restaurantTimeAdjustment.count({ where: { shiftId: ids.shiftId } })).toBe(0);
    });
  });
});
