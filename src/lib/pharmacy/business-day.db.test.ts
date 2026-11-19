/**
 * @vitest-environment node
 *
 * DEV-958A against a REAL migrated PostgreSQL, on the real clock:
 *
 * - A branch closed yesterday on midnight days; the owner moves the day end to 05:00. The change
 *   is appended as a dated history entry starting the day after tomorrow, with its audit row, and
 *   yesterday's close and cash-close check read exactly what they read before.
 * - The database itself keeps the history append-only and future-only: as the restricted runtime
 *   role, a back-dated entry, a rewrite, a removal, a malformed entry and an out-of-order entry
 *   are refused; the application's own save goes through, and of two concurrent saves at one
 *   revision exactly one wins.
 * - A report across branches is the sum of each branch's own business days, each on its own
 *   hour history: it never depends on another branch's hour, on a later change, or on a branch
 *   being added, and the all-branch day equals the sum of the branch days and of the rows.
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
let reports: typeof import('./reports');

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const ZONE = 'Asia/Karachi';
/** Karachi has no daylight saving: local time is UTC+05:00 all year. */
const KARACHI_OFFSET_MS = 5 * 3_600_000;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  dayClose = await import('./day-close');
  settlement = await import('./settlement');
  settings = await import('./business-day-settings');
  clock = await import('./business-day-clock');
  businessDay = await import('./business-day');
  cashCloseCheck = await import('./cash-close-check-operations');
  reports = await import('./reports');

  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);
}, 60_000);

const tenant = <T>(scope: Scope, work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(scope.organizationId, work, { userId: scope.actorId });

/** Today's business day of a branch on midnight days in Karachi, and a day `offset` from it. */
function today(offset = 0) {
  return businessDay.shiftPharmacyDay(
    businessDay.pharmacyBusinessDay({ timeZone: ZONE }, new Date()),
    offset
  );
}
const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** The instant of `HH:MM` Karachi time on calendar day `day`. */
const karachi = (day: string, time: string) =>
  new Date(new Date(`${day}T${time}:00.000Z`).getTime() - KARACHI_OFFSET_MS);

/** A Karachi organisation, its owner, and branches with no day-end change. */
async function organization(label: string, branchLabels: readonly string[]) {
  const organizationId = `dayend_${label}_${run}`;
  const actorId = `dayend-actor-${label}-${run}`;
  await withPlatformDb((db) =>
    db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: `Day end ${label}`,
        displayName: `Day end ${label}`,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        timezone: ZONE,
      },
    })
  );
  await withPlatformDb(async (db) => {
    const { seedDepartments } = await import('@/lib/test-support/departments');
    await seedDepartments(db, [organizationId], ['LEADERSHIP']);
  });
  const owner: Scope = { organizationId, branchId: '', actorId };
  await tenant(owner, (db) =>
    // The owner who changes the hour: the audit row names a real member.
    db.user.create({
      data: {
        id: actorId,
        organizationId,
        name: `Owner ${label}`,
        email: `${actorId}@day-end.test`,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Pharmacy owner',
        status: 'ACTIVE',
      },
    })
  );
  const scopes = [];
  for (const branchLabel of branchLabels) scopes.push(await addBranch(owner, branchLabel));
  return scopes;
}

async function addBranch(owner: Scope, branchLabel: string): Promise<Scope> {
  const scope = { ...owner, branchId: `${owner.organizationId}_${branchLabel}` };
  await tenant(scope, (db) =>
    db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId: scope.organizationId,
        code: scope.branchId,
        name: `Day end ${branchLabel}`,
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    })
  );
  return scope;
}

/** A branch that traded and closed `day` on midnight days. */
async function closedDay(label: string, day: string) {
  const [scope] = await organization(label, ['main']);
  const businessDate = asDate(day);
  const drawer = await tenant(scope!, (db) =>
    settlement.openPharmacyDrawer(db, scope!, {
      deviceId: `device-${label}`,
      businessDate,
      openingFloatMinor: 10_000,
    })
  );
  const preview = await tenant(scope!, (db) =>
    dayClose.readPharmacyClose(db, scope!, businessDate)
  );
  await tenant(scope!, (db) =>
    dayClose.closePharmacyDay(db, scope!, {
      businessDate,
      sourceHash: preview.totals.sourceHash,
      counts: [{ drawerSessionId: drawer.id, countedCashMinor: 10_000 }],
      varianceNote: '',
    })
  );
  return scope!;
}

/** What the day's close screen and the owner's cash-close check read for `day`. */
async function readDay(scope: Scope, day: string) {
  const businessDate = asDate(day);
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

/** Saves through the application path, at the branch's current revision. */
async function saveHour(scope: Scope, dayEndsAtHour: number) {
  const setting = await tenant(scope, (db) => settings.readPharmacyDayEndHourSetting(db, scope));
  return tenant(scope, (db) =>
    settings.savePharmacyDayEndHour(
      db,
      scope,
      { revision: setting.revision, dayEndsAtHour },
      { id: scope.actorId }
    )
  );
}

async function storedHistory(scope: Scope) {
  return tenant(scope, (db) =>
    db.pharmacyBranch.findFirstOrThrow({
      where: { organizationId: scope.organizationId, id: scope.branchId },
      select: { businessDayEndsAtHistory: true, businessDayEndsAtRevision: true },
    })
  );
}

/** Writes the history straight to the row, as the restricted runtime role, past the app. */
async function writeHistory(scope: Scope, history: unknown) {
  return tenant(scope, (db) =>
    db.pharmacyBranch.updateMany({
      where: { organizationId: scope.organizationId, id: scope.branchId },
      data: { businessDayEndsAtHistory: history as never },
    })
  );
}

describeDatabase('pharmacy day-end hour on migrated PostgreSQL (DEV-958A)', () => {
  it('appends the change for the day after tomorrow, audits it, and leaves closed days as they were', async () => {
    const yesterday = today(-1);
    const scope = await closedDay('history', yesterday);
    const before = await readDay(scope, yesterday);
    const setting = await tenant(scope, (db) => settings.readPharmacyDayEndHourSetting(db, scope));
    expect(setting).toMatchObject({
      dayEndsAtHour: 0,
      scheduledHour: 0,
      pendingChanges: [],
      currentBusinessDay: today(),
      nextBusinessDay: today(1),
    });
    const at = Date.now();
    await expect(saveHour(scope, 5)).resolves.toMatchObject({
      dayEndsAtHour: 5,
      fromBusinessDay: today(1),
    });

    const stored = await storedHistory(scope);
    expect(stored).toEqual({
      businessDayEndsAtHistory: [
        { from: today(2), hour: 5, actorId: scope.actorId, at: expect.any(String) },
      ],
      businessDayEndsAtRevision: setting.revision + 1,
    });
    const [entry] = stored.businessDayEndsAtHistory as Array<{ at: string }>;
    expect(Date.parse(entry!.at)).toBeGreaterThanOrEqual(at);
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
        endsFromBusinessDay: today(1),
        startsFromBusinessDay: today(2),
      },
    });

    // Yesterday's close reads the same, and so do today and every earlier day.
    expect(await readDay(scope, yesterday)).toEqual(before);
    const branchClock = await tenant(scope, (db) => clock.readPharmacyDayClock(db, scope));
    for (const day of [today(-30), today(-7), yesterday, today()])
      expect(businessDay.pharmacyBusinessDayRange(day, day, branchClock)).toEqual(
        businessDay.pharmacyBusinessDayRange(day, day, { timeZone: ZONE })
      );
    // Tomorrow starts as usual and is the first day to end at 05:00.
    expect(businessDay.pharmacyBusinessDayRange(today(1), today(1), branchClock)).toEqual({
      from: karachi(today(1), '00:00'),
      to: karachi(today(2), '05:00'),
    });
    // The panel: today still ends at midnight, and the change ahead names tomorrow.
    await expect(
      tenant(scope, (db) => settings.readPharmacyDayEndHourSetting(db, scope))
    ).resolves.toMatchObject({
      dayEndsAtHour: 0,
      scheduledHour: 5,
      pendingChanges: [{ fromBusinessDay: today(1), hour: 5 }],
    });
  });

  it('refuses, as the restricted runtime role, any history that would move a begun day', async () => {
    const [scope] = await organization('guard', ['main']);
    const refused = (history: unknown) => expect(writeHistory(scope!, history)).rejects.toThrow();
    // Not a list, and entries that are not changes.
    await refused({ from: today(5), hour: 5 });
    await refused([{ from: today(5), hour: 7 }]);
    await refused([{ from: today(5), hour: -1 }]);
    await refused([{ from: today(5), hour: 2.5 }]);
    await refused([{ from: today(5), hour: '5' }]);
    await refused([{ from: '2027-02-30', hour: 5 }]);
    await refused([{ from: '5 Dec 2030', hour: 5 }]);
    await refused([{ hour: 5 }]);
    await refused(['2030-12-05']);
    // Back-dated: today and tomorrow have begun or are fixed; only the day after can change.
    await refused([{ from: today(-1), hour: 5 }]);
    await refused([{ from: today(), hour: 5 }]);
    await refused([{ from: today(1), hour: 5 }]);
    expect((await storedHistory(scope!)).businessDayEndsAtHistory).toEqual([]);

    // The application's own save goes through, with the day after tomorrow.
    await expect(saveHour(scope!, 5)).resolves.toMatchObject({ fromBusinessDay: today(1) });
    const { businessDayEndsAtHistory: first } = await storedHistory(scope!);
    expect(first).toEqual([expect.objectContaining({ from: today(2), hour: 5 })]);
    const [kept] = first as Array<Record<string, unknown>>;

    // An entry already stored can never be rewritten or removed.
    await refused([]);
    await refused([{ ...kept, hour: 3 }]);
    await refused([{ ...kept, from: today(9) }]);
    await refused([{ ...kept, actorId: 'someone-else' }]);
    await refused([{ from: today(9), hour: 3 }, kept]);
    // A new entry is in date order after the last one, and never back-dated.
    await refused([kept, { from: today(1), hour: 3 }]);
    await expect(writeHistory(scope!, [kept, { from: today(9), hour: 3 }])).resolves.toEqual({
      count: 1,
    });
    await refused([kept, { from: today(9), hour: 3 }, { from: today(8), hour: 2 }]);
    // A branch cannot be created with a back-dated history either.
    await expect(
      tenant(scope!, (db) =>
        db.pharmacyBranch.create({
          data: {
            id: `${scope!.organizationId}_backdated`,
            organizationId: scope!.organizationId,
            code: `${scope!.organizationId}_backdated`,
            name: 'Back-dated',
            addressLine: 'Test',
            city: 'Test',
            provinceCode: 'PB',
            businessDayEndsAtHistory: [{ from: today(-3), hour: 5 }],
          },
        })
      )
    ).rejects.toThrow();
    expect((await storedHistory(scope!)).businessDayEndsAtHistory).toEqual([
      kept,
      { from: today(9), hour: 3 },
    ]);
  });

  it('lets exactly one of two concurrent saves at one revision win', async () => {
    const [scope] = await organization('race', ['main']);
    const setting = await tenant(scope!, (db) =>
      settings.readPharmacyDayEndHourSetting(db, scope!)
    );
    const results = await Promise.allSettled(
      [3, 5].map((dayEndsAtHour) =>
        tenant(scope!, (db) =>
          settings.savePharmacyDayEndHour(
            db,
            scope!,
            { revision: setting.revision, dayEndsAtHour },
            { id: scope!.actorId }
          )
        )
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((result) => result.status === 'rejected');
    expect(lost).toMatchObject({ reason: { reason: 'REVISION_CONFLICT' } });
    const stored = await storedHistory(scope!);
    expect(stored.businessDayEndsAtRevision).toBe(setting.revision + 1);
    expect(stored.businessDayEndsAtHistory).toHaveLength(1);
    await expect(
      tenant(scope!, (db) =>
        settings.savePharmacyDayEndHour(
          db,
          scope!,
          { revision: 99, dayEndsAtHour: 5 },
          { id: scope!.actorId }
        )
      )
    ).rejects.toMatchObject({ reason: 'REVISION_CONFLICT' });
  });
});

describeDatabase('a report across branches on migrated PostgreSQL (DEV-958A)', () => {
  // Lost-demand events, one row each, at Karachi times around a past day X: two after midnight
  // but before 05:00, two in X's daytime and evening, one after midnight into X+1.
  const X = () => today(-10);
  const instants = () => [
    karachi(X(), '00:30'),
    karachi(X(), '03:00'),
    karachi(X(), '12:00'),
    karachi(X(), '23:30'),
    karachi(businessDay.shiftPharmacyDay(X(), 1), '00:30'),
  ];

  async function seedDemand(scope: Scope) {
    await tenant(scope, async (db) => {
      for (const createdAt of instants())
        await db.unfulfilledDemandEvent.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            saleUnit: 'PACK',
            quantity: 1,
            reason: 'STOCKOUT',
            requestedText: 'Requested test medicine',
            inventoryRuleSnapshot: {},
            capturedByUserId: scope.actorId,
            createdAt,
          },
        });
    });
  }

  /** The command centre's lost-demand count for `day`, across `scopes`, on `dayEnds`. */
  async function lostDemand(
    scopes: readonly Scope[],
    from: string,
    to: string,
    dayEnds?: Record<string, unknown>
  ) {
    const centre = await tenant(scopes[0]!, (db) =>
      reports.readPharmacyOwnerCommandCentre(db, {
        branchIds: scopes.map((scope) => scope.branchId),
        from,
        to,
        timeZone: ZONE,
        ...businessDay.pharmacyBranchDayEndsField(
          scopes.map((scope) => ({ id: scope.branchId, dayEnd: dayEnds?.[scope.branchId] }))
        ),
      })
    );
    return centre.metrics.lostDemandEvents;
  }

  /** The days around X, each as the all-branch figure and each branch's own figure. */
  async function days(scopes: readonly Scope[], dayEnds?: Record<string, unknown>) {
    const out: Record<string, { all: number | null; branches: (number | null)[] }> = {};
    for (const offset of [-1, 0, 1]) {
      const day = businessDay.shiftPharmacyDay(X(), offset);
      out[day] = {
        all: await lostDemand(scopes, day, day, dayEnds),
        branches: await Promise.all(scopes.map((scope) => lostDemand([scope], day, day, dayEnds))),
      };
    }
    return out;
  }

  /** The stored histories, as the reports router reads them for its filters. */
  async function storedDayEnds(scopes: readonly Scope[]) {
    const rows = await tenant(scopes[0]!, (db) =>
      db.pharmacyBranch.findMany({
        where: { id: { in: scopes.map((scope) => scope.branchId) } },
        select: { id: true, businessDayEndsAtHistory: true },
      })
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.businessDayEndsAtHistory]));
  }

  it('adds up each branch on its own hours, whatever another branch ends at', async () => {
    const [late, early] = await organization('mixed', ['late', 'early']);
    await seedDemand(late!);
    await seedDemand(early!);
    const before = businessDay.shiftPharmacyDay(X(), -1);
    const after = businessDay.shiftPharmacyDay(X(), 1);
    // The late branch has ended its days at 05:00 since well before X; the other at midnight.
    const lateHistory = [{ from: today(-40), hour: 5 }];
    const mixed = await days([late!, early!], { [late!.branchId]: lateHistory });
    expect(mixed).toEqual({
      // The late branch's day before X runs to 05:00 on X: its 00:30 and 03:00 rows.
      [before]: { all: 2, branches: [2, 0] },
      // X: the late branch has 12:00, 23:30 and the next 00:30; the other has X's four rows.
      [X()]: { all: 7, branches: [3, 4] },
      [after]: { all: 1, branches: [0, 1] },
    });
    // Every all-branch day is the sum of the branch days, and the days add up to the rows.
    for (const day of Object.values(mixed))
      expect(day.all).toBe(day.branches.reduce((sum, value) => sum! + value!, 0));
    expect(Object.values(mixed).reduce((sum, day) => sum + day.all!, 0)).toBe(
      2 * instants().length
    );
    expect(
      await lostDemand([late!, early!], before, after, { [late!.branchId]: lateHistory })
    ).toBe(2 * instants().length);

    // The midnight branch's figures never depend on the other branch's hour: they are the same
    // with the late branch on midnight, and the late branch's are the same without its partner.
    const allMidnight = await days([late!, early!]);
    for (const day of Object.keys(mixed)) {
      expect(mixed[day]!.branches[1]).toBe(allMidnight[day]!.branches[1]);
      expect(mixed[day]!.branches[0]).toBe(
        await lostDemand([late!], day, day, { [late!.branchId]: lateHistory })
      );
    }
    // Nor on a later change of the late branch's hour: days before it keep their figures.
    const changedLater = [...lateHistory, { from: today(-3), hour: 2 }];
    expect(await days([late!, early!], { [late!.branchId]: changedLater })).toEqual(mixed);
  });

  it('keeps every past all-branch day when a branch changes its hour or a branch is added', async () => {
    const [first, second] = await organization('stored', ['first', 'second']);
    await seedDemand(first!);
    await seedDemand(second!);
    const pastDays = await days([first!, second!], await storedDayEnds([first!, second!]));
    const pastRange = await lostDemand(
      [first!, second!],
      today(-30),
      today(-1),
      await storedDayEnds([first!, second!])
    );
    expect(pastRange).toBe(2 * instants().length);

    // A branch changes its hour through the application, and a new branch with its own hour
    // joins; neither moves any past day of the report across branches.
    await saveHour(first!, 5);
    const third = await addBranch(first!, 'third');
    await saveHour(third, 3);
    const stored = await storedDayEnds([first!, second!, third]);
    expect(
      Object.keys(
        businessDay.pharmacyBranchDayEndsField(
          Object.entries(stored).map(([id, dayEnd]) => ({ id, dayEnd }))
        ).dayEnds ?? {}
      ).sort()
    ).toEqual([first!.branchId, third.branchId].sort());
    expect(await days([first!, second!], stored)).toEqual(pastDays);
    const withThird = await days([first!, second!, third], stored);
    for (const [day, figures] of Object.entries(withThird)) {
      expect(figures.all).toBe(pastDays[day]!.all);
      expect(figures.branches).toEqual([...pastDays[day]!.branches, 0]);
    }
    expect(await lostDemand([first!, second!, third], today(-30), today(-1), stored)).toBe(
      pastRange
    );
  });
});
