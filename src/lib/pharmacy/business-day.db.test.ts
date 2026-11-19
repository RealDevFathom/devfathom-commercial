/**
 * @vitest-environment node
 *
 * DEV-958A against a REAL migrated PostgreSQL. A branch trades and closes 18 Nov on midnight
 * days, then the owner moves the day end to 05:00. The change is stored as a dated, appended
 * history entry with its audit row; the closed day's close preview and cash-close check read
 * exactly what they read before the change; and the database refuses a history that is not a
 * list.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the restricted
 * runtime role. The suite first proves that role is neither SUPERUSER nor BYPASSRLS. Without
 * the URL it reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Scope = { organizationId: string; branchId: string; actorId: string };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let dayClose: typeof import('./day-close');
let settlement: typeof import('./settlement');
let settings: typeof import('./business-day-settings');
let clock: typeof import('./business-day-clock');
let businessDay: typeof import('./business-day');
let cashCloseCheck: typeof import('./cash-close-check-operations');

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const businessDate = new Date('2026-11-18T00:00:00.000Z');
// 23:30 on 18 Nov in Karachi, after the day close.
const changedAt = new Date('2026-11-18T18:30:00.000Z');

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  dayClose = await import('./day-close');
  settlement = await import('./settlement');
  settings = await import('./business-day-settings');
  clock = await import('./business-day-clock');
  businessDay = await import('./business-day');
  cashCloseCheck = await import('./cash-close-check-operations');

  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);
}, 60_000);

const tenant = <T>(scope: Scope, work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(scope.organizationId, work, { userId: scope.actorId });

/** A Karachi organisation and branch that traded and closed 18 Nov on midnight days. */
async function closedDay(label: string) {
  const organizationId = `dayend_${label}_${run}`;
  const scope: Scope = {
    organizationId,
    branchId: `dayend_branch_${label}_${run}`,
    actorId: `dayend-actor-${label}-${run}`,
  };
  await withPlatformDb((db) =>
    db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: `Day end ${label}`,
        displayName: `Day end ${label}`,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: 'Asia/Karachi',
      },
    })
  );
  await withPlatformDb(async (db) => {
    const { seedDepartments } = await import('@/lib/test-support/departments');
    await seedDepartments(db, [organizationId], ['LEADERSHIP']);
  });
  const drawer = await tenant(scope, async (db) => {
    // The owner who changes the hour: the audit row names a real member.
    await db.user.create({
      data: {
        id: scope.actorId,
        organizationId,
        name: `Owner ${label}`,
        email: `${scope.actorId}@day-end.test`,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Pharmacy owner',
        status: 'ACTIVE',
      },
    });
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId,
        code: scope.branchId,
        name: `Day end ${label}`,
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    });
    return settlement.openPharmacyDrawer(db, scope, {
      deviceId: `device-${label}`,
      businessDate,
      openingFloatMinor: 10_000,
    });
  });
  const preview = await tenant(scope, (db) => dayClose.readPharmacyClose(db, scope, businessDate));
  await tenant(scope, (db) =>
    dayClose.closePharmacyDay(db, scope, {
      businessDate,
      sourceHash: preview.totals.sourceHash,
      counts: [{ drawerSessionId: drawer.id, countedCashMinor: 10_000 }],
      varianceNote: '',
    })
  );
  return scope;
}

/** What the day's close screen and the owner's cash-close check read for 18 Nov. */
async function readDay(scope: Scope) {
  const close = await tenant(scope, (db) => dayClose.readPharmacyClose(db, scope, businessDate));
  const check = await tenant(scope, (db) =>
    cashCloseCheck.readPharmacyCashCloseCheck(db, scope, businessDate)
  );
  // The preview names the branch's day-end history, which the change appends to; every figure,
  // the close and the check are what must not move.
  const { dayEnd: _dayEnd, ...figures } = close;
  void _dayEnd;
  return { figures, check };
}

describeDatabase('pharmacy day-end hour on migrated PostgreSQL (DEV-958A)', () => {
  it('appends the change, audits it, and leaves the closed day exactly as it was', async () => {
    const scope = await closedDay('history');
    const before = await readDay(scope);
    const setting = await tenant(scope, (db) =>
      settings.readPharmacyDayEndHourSetting(db, scope, changedAt)
    );
    expect(setting).toMatchObject({
      dayEndsAtHour: 0,
      currentBusinessDay: '2026-11-18',
      nextChangeDay: '2026-11-20',
    });
    await expect(
      tenant(scope, (db) =>
        settings.savePharmacyDayEndHour(
          db,
          scope,
          { revision: setting.revision, dayEndsAtHour: 5 },
          { id: scope.actorId },
          changedAt
        )
      )
    ).resolves.toMatchObject({ dayEndsAtHour: 5, from: '2026-11-20' });

    const stored = await tenant(scope, (db) =>
      db.pharmacyBranch.findFirstOrThrow({
        where: { organizationId: scope.organizationId, id: scope.branchId },
        select: { businessDayEndsAtHistory: true, businessDayEndsAtRevision: true },
      })
    );
    expect(stored).toEqual({
      businessDayEndsAtHistory: [
        { from: '2026-11-20', hour: 5, actorId: scope.actorId, at: changedAt.toISOString() },
      ],
      businessDayEndsAtRevision: setting.revision + 1,
    });
    const audit = await tenant(scope, (db) =>
      db.auditLog.findFirst({
        where: {
          organizationId: scope.organizationId,
          action: settings.PHARMACY_DAY_END_HOUR_SET_ACTION,
          targetId: scope.branchId,
        },
        select: { actorId: true, changes: true },
      })
    );
    expect(audit).toEqual({
      actorId: scope.actorId,
      changes: {
        businessDayEndsAtHour: { before: 0, after: 5 },
        effectiveFromBusinessDay: '2026-11-20',
      },
    });

    // The closed day reads the same, and so does every day before the change.
    expect(await readDay(scope)).toEqual(before);
    const branchClock = await tenant(scope, (db) => clock.readPharmacyDayClock(db, scope));
    for (const day of ['2026-11-01', '2026-11-09', '2026-11-18'])
      expect(businessDay.pharmacyBusinessDayRange(day, day, branchClock)).toEqual(
        businessDay.pharmacyBusinessDayRange(day, day, { timeZone: 'Asia/Karachi' })
      );
    // 19 Nov, the next business day, ends at 05:00 on 20 Nov.
    expect(businessDay.pharmacyBusinessDayRange('2026-11-19', '2026-11-19', branchClock)).toEqual({
      from: new Date('2026-11-18T19:00:00.000Z'),
      to: new Date('2026-11-20T00:00:00.000Z'),
    });
  });

  it('refuses a stale revision and a history that is not a list', async () => {
    const scope = await closedDay('refusals');
    await expect(
      tenant(scope, (db) =>
        settings.savePharmacyDayEndHour(
          db,
          scope,
          { revision: 99, dayEndsAtHour: 5 },
          { id: scope.actorId },
          changedAt
        )
      )
    ).rejects.toMatchObject({ reason: 'REVISION_CONFLICT' });
    await expect(
      tenant(scope, (db) =>
        db.pharmacyBranch.updateMany({
          where: { organizationId: scope.organizationId, id: scope.branchId },
          data: { businessDayEndsAtHistory: { from: '2026-11-20', hour: 5 } },
        })
      )
    ).rejects.toThrow();
  });
});
