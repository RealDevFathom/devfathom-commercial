/**
 * @vitest-environment node
 *
 * The day close against a REAL migrated PostgreSQL. `pharmacy_daily_closes` is
 * append-only: trigger `pharmacy_daily_closes_append_only` rejects every UPDATE
 * and DELETE, and the table's tenant policy lets an UPDATE reach that trigger.
 * The operator's variance note therefore has to be written with the Z report,
 * never added to it afterwards. The unit suite mocks the client and cannot see
 * the trigger, so this one runs the real `closePharmacyDay`, and the real
 * `cutPharmacyDailyClose` beneath it, with the trigger in place.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role. The suite first proves that role is neither
 * SUPERUSER nor BYPASSRLS. Without the URL it reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// The close takes the day lock (pg_advisory_xact_lock), whose void result only the application
// client in '@/lib/db' decodes, so every transaction here goes through withTenantDb, as the
// closeDay mutation's does.

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Scope = { organizationId: string; branchId: string; actorId: string };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let dayClose: typeof import('./day-close');
let settlement: typeof import('./settlement');

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const businessDate = new Date('2026-09-29T00:00:00.000Z');

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  dayClose = await import('./day-close');
  settlement = await import('./settlement');

  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);
  // Cold imports of the settlement graph exceed the default on a busy host.
}, 60_000);

const tenant = <T>(scope: Scope, work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(scope.organizationId, work, { userId: scope.actorId });

/** A fresh organization and branch, with one drawer open on a 100.00 float for the day. */
async function openDay(label: string) {
  const organizationId = `dayclose_${label}_${run}`;
  const scope: Scope = {
    organizationId,
    branchId: `dayclose_branch_${label}_${run}`,
    actorId: `dayclose-actor-${label}`,
  };
  await withPlatformDb((db) =>
    db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: `Day close ${label}`,
        displayName: `Day close ${label}`,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
      },
    })
  );
  const drawer = await tenant(scope, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId,
        code: scope.branchId,
        name: `Day close ${label}`,
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
  return { scope, drawerId: drawer.id };
}

/**
 * What the close console and the closeDay mutation do: count against the preview's hash, then
 * close in one tenant transaction. The input is returned so a retry can resend it unchanged.
 */
async function closeDay(
  scope: Scope,
  drawerId: string,
  countedCashMinor: number,
  varianceNote: string
) {
  const preview = await tenant(scope, (db) => dayClose.readPharmacyClose(db, scope, businessDate));
  const input = {
    businessDate,
    sourceHash: preview.totals.sourceHash,
    counts: [{ drawerSessionId: drawerId, countedCashMinor }],
    varianceNote,
  };
  const close = await tenant(scope, (db) => dayClose.closePharmacyDay(db, scope, input));
  return { input, close };
}

/** Every close row of the day, read back in a new transaction. */
const closesOf = (scope: Scope) =>
  tenant(scope, (db) =>
    db.pharmacyDailyClose.findMany({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, businessDate },
      orderBy: { sequence: 'asc' },
    })
  );

describeDatabase('pharmacy day close on migrated PostgreSQL', () => {
  it('records the variance note on the close row, which stays append-only', async () => {
    const day = await openDay('note');
    const { close } = await closeDay(
      day.scope,
      day.drawerId,
      9_900,
      '  One rupee short at nightly count '
    );
    expect(close).toMatchObject({
      sequence: 1,
      supersedesCloseId: null,
      reason: 'One rupee short at nightly count',
      cashExpectedMinor: 10_000,
      cashCountedMinor: 9_900,
      cashVarianceMinor: -100,
    });
    // Committed together: the one close row carries the note, and the drawer is closed.
    expect(await closesOf(day.scope)).toEqual([close]);
    const drawer = await tenant(day.scope, (db) =>
      db.pharmacyDrawerSession.findFirstOrThrow({ where: { id: day.drawerId } })
    );
    expect(drawer).toMatchObject({ status: 'CLOSED', countedCashMinor: 9_900 });

    // The guard is still there for this role: the recorded close cannot be edited afterwards.
    await expect(
      tenant(day.scope, (db) =>
        db.pharmacyDailyClose.update({
          where: { organizationId_id: { organizationId: day.scope.organizationId, id: close.id } },
          data: { reason: 'Edited after the close' },
        })
      )
    ).rejects.toThrow(/pharmacy_daily_closes is append-only/);
    expect((await closesOf(day.scope)).map((row) => row.reason)).toEqual([
      'One rupee short at nightly count',
    ]);
  });

  it('returns the recorded close on a transport retry and never cuts a second one', async () => {
    const day = await openDay('retry');
    const first = await closeDay(day.scope, day.drawerId, 9_950, 'Coin tray miscounted');
    // A lost response: the counter resends the very same request after the close committed.
    const retried = await tenant(day.scope, (db) =>
      dayClose.closePharmacyDay(db, day.scope, first.input)
    );
    expect(retried).toEqual(first.close);
    const closes = await closesOf(day.scope);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({
      id: first.close.id,
      sequence: 1,
      reason: 'Coin tray miscounted',
    });
  });

  it('stores no reason when the count matches and the note is blank', async () => {
    const day = await openDay('exact');
    const { close } = await closeDay(day.scope, day.drawerId, 10_000, '   ');
    expect(close).toMatchObject({ sequence: 1, reason: null, cashVarianceMinor: 0 });
    expect((await closesOf(day.scope)).map((row) => row.reason)).toEqual([null]);
  });

  it('keeps the re-close rules: only a reopen reason re-cuts the day, and it is what is stored', async () => {
    const day = await openDay('reopen');
    const { close } = await closeDay(day.scope, day.drawerId, 9_900, 'Short at the count');
    // A variance note never stands in for the reopen reason a second close requires.
    await expect(
      tenant(day.scope, (db) =>
        settlement.cutPharmacyDailyClose(db, day.scope, {
          businessDate,
          varianceNote: 'Short again',
        })
      )
    ).rejects.toMatchObject({ reason: 'REOPEN_REASON_REQUIRED' });
    const reclosed = await tenant(day.scope, (db) =>
      settlement.cutPharmacyDailyClose(db, day.scope, {
        businessDate,
        reopenReason: '  Late refund found  ',
      })
    );
    expect(reclosed).toMatchObject({
      sequence: 2,
      supersedesCloseId: close.id,
      reason: 'Late refund found',
    });
    expect((await closesOf(day.scope)).map((row) => [row.sequence, row.reason])).toEqual([
      [1, 'Short at the count'],
      [2, 'Late refund found'],
    ]);
  });
});
