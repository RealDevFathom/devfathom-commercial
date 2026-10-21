/**
 * @vitest-environment node
 *
 * H1-03 inventory against a REAL migrated PostgreSQL: forced RLS on the five
 * tables, the composite foreign keys that confine every link to one tenant and
 * one property, the trigger-owned ledger, the structure guard's capacity lock,
 * the status matrix, the block exclusion, and the engine's transaction
 * behaviour under concurrency.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the
 * restricted runtime role (neither SUPERUSER nor BYPASSRLS — asserted first,
 * because everything below is decided by row-level security and a bypassing
 * role would make it vacuous). Without the URL the suite reports itself
 * skipped rather than passing vacuously.
 *
 * The tenant is seeded from the control plane (`seedHotelTenant`), the way
 * provisioning creates one: the RESTRICTIVE property policy makes a property
 * unreachable from inside the tenant until an assignment names the acting
 * user, and the first assignment cannot be written before the property exists.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { PrismaClient, type Prisma } from '@/generated/prisma/client';
import {
  HotelInventoryError,
  createInventoryBlock,
  createInventoryRoom,
  hotelRoomCreateInput,
  hotelRoomTypeCreateInput,
  inventoryTransitionAllowed,
  inventoryWhere,
  lockSellableUnitCeiling,
  releaseInventoryBlock,
  reserveSellableUnits,
  sellableUnitsUsed,
  setInventoryStatus,
  withHotelInventory,
  HOUSEKEEPING_ROOM_STATUSES,
  type HotelInventoryScope,
} from './inventory';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

// See jobs.purge.db.test.ts: a connection string avoids the cross-realm pg.Pool
// instanceof failure the shared client hits under Vitest.
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 10 }),
    log: ['error'],
  }),
}));

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');

type Scope = HotelInventoryScope & { userId: string };
const scope: Scope = {
  organizationId: `hotel_inv_a_${suffix}`,
  branchId: '',
  actorId: '',
  userId: '',
};
/** A second property of the same organization. */
const sibling: Scope = { ...scope };
/** Another organization altogether. */
const other: Scope = { ...scope, organizationId: `hotel_inv_b_${suffix}` };

type Tx = Prisma.TransactionClient;
let db: PrismaClient;
let withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
let typeId: string;
let roomId: string;
const tables = [
  'hotel_room_types',
  'hotel_rooms',
  'hotel_beds',
  'hotel_room_status_events',
  'hotel_room_blocks',
];

function within<T>(s: Scope, run: (tx: Tx) => Promise<T>, reason = 'Inventory test') {
  return withTenantDb(s.organizationId, (tx) => withHotelInventory(tx, s, reason, run), {
    userId: s.userId,
  });
}
async function makeType(
  s: Scope,
  inventoryKind: 'ROOM' | 'BED' | 'UNIT' = 'ROOM',
  bedsPerRoom?: number,
  active = true
) {
  return within(s, (tx) =>
    tx.hotelRoomType.create({
      data: {
        ...hotelRoomTypeCreateInput.parse({
          code: randomBytes(5).toString('hex'),
          name: 'Fixture',
          inventoryKind,
          bedsPerRoom,
          baseAdults: 1,
          maxAdults: 2,
          maxChildren: 0,
        }),
        organizationId: s.organizationId,
        branchId: s.branchId,
        active,
      },
    })
  );
}
async function makeRoom(s = scope, roomTypeId = typeId, extra: Record<string, unknown> = {}) {
  return within(s, (tx) =>
    createInventoryRoom(
      tx,
      s,
      hotelRoomCreateInput.parse({
        roomTypeId,
        number: randomBytes(5).toString('hex'),
        reason: 'Commissioned',
        ...extra,
      })
    )
  );
}
const rejectsWith = (code: HotelInventoryError['code']) =>
  expect.objectContaining({ name: 'HotelInventoryError', code });

describeIfDatabase('inventory with restricted runtime and forced RLS', () => {
  beforeAll(async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      if (
        !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(TEST_DATABASE_URL!).hostname)
      ) {
        throw new Error('Inventory tests require a local disposable database');
      }
      const posture = await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(posture.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    } finally {
      await client.end();
    }
    ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    ({ db } = await import('@/lib/db'));
    const { seedHotelTenant } = await import('@/lib/testing/hotel-tenant-fixture');

    const tenantA = await seedHotelTenant(withPlatformDb, {
      organizationId: scope.organizationId,
      properties: [{ name: 'Main property' }, { name: 'Sibling property' }],
    });
    const tenantB = await seedHotelTenant(withPlatformDb, {
      organizationId: other.organizationId,
      properties: [{ name: 'Other property' }],
    });
    Object.assign(scope, {
      branchId: tenantA.branchIds[0],
      actorId: tenantA.userId,
      userId: tenantA.userId,
    });
    Object.assign(sibling, {
      branchId: tenantA.branchIds[1],
      actorId: tenantA.userId,
      userId: tenantA.userId,
    });
    Object.assign(other, {
      branchId: tenantB.branchIds[0],
      actorId: tenantB.userId,
      userId: tenantB.userId,
    });

    for (const s of [scope, sibling, other]) {
      const type = await makeType(s, 'BED', 2);
      const room = await makeRoom(s, type.id);
      await within(s, (tx) =>
        createInventoryBlock(tx, s, {
          roomId: room.id,
          kind: 'OUT_OF_ORDER',
          startDate: '2026-09-12',
          endDate: '2026-09-13',
          reason: 'Fixture repair',
        })
      );
      if (s === scope) {
        typeId = type.id;
        roomId = room.id;
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('pins all five tables to ENABLE and FORCE RLS and runtime is neither SUPERUSER nor BYPASSRLS', async () => {
    const result = await within(
      scope,
      (tx) => tx.$queryRaw<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY(${tables}) ORDER BY relname`
    );
    expect(result).toEqual(
      tables
        .toSorted()
        .map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true }))
    );
    const roles = await within(
      scope,
      (tx) => tx.$queryRaw`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(roles).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it.each(tables)(
    '%s hides other tenants without query filters; sibling properties are separated by the branch predicate',
    async (table) => {
      for (const s of [scope, other]) {
        const rows = await within(s, (tx) =>
          tx.$queryRawUnsafe<{ organizationId: string; branchId: string }[]>(
            `SELECT "organizationId", "branchId" FROM "${table}"`
          )
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.organizationId === s.organizationId)).toBe(true);
      }
      // Isolation is per organization. Within it, the property is a predicate
      // the resolver supplies from the resolved scope — never a session fact.
      const siblingRows = await within(scope, (tx) =>
        tx.$queryRawUnsafe<{ branchId: string }[]>(
          `SELECT "branchId" FROM "${table}" WHERE "branchId" = $1`,
          sibling.branchId
        )
      );
      expect(siblingRows.length).toBeGreaterThan(0);
      // Fail closed: a transaction that names no organization sees nothing.
      const unscoped = await withTenantDb(scope.organizationId, async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_organization_id', '', true)`;
        return tx.$queryRawUnsafe(`SELECT * FROM "${table}"`);
      });
      expect(unscoped).toEqual([]);
    }
  );

  it('refuses forged tenant writes and cross-property relationships', async () => {
    await expect(
      within(scope, (tx) =>
        tx.hotelRoomType.create({
          data: {
            organizationId: other.organizationId,
            branchId: other.branchId,
            code: 'FORGED',
            name: 'Forged',
          },
        })
      )
    ).rejects.toThrow();
    // A room keys into its type by (organization, property, id): a type from
    // the sibling property is a dangling reference, not a link.
    const siblingType = await makeType(sibling);
    await expect(
      within(scope, (tx) =>
        tx.hotelRoom.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            roomTypeId: siblingType.id,
            inventoryKind: siblingType.inventoryKind,
            number: 'bad-fk',
            statusChangedBy: scope.actorId,
          },
        })
      )
    ).rejects.toThrow();
    const siblingRoom = await makeRoom(sibling, siblingType.id);
    await expect(
      within(scope, (tx) =>
        tx.hotelRoom.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            roomTypeId: typeId,
            inventoryKind: 'BED',
            number: 'bad-connection',
            connectingRoomId: siblingRoom.id,
            statusChangedBy: scope.actorId,
          },
        })
      )
    ).rejects.toThrow();
    // The engine answers the same cases as "not one of this property's".
    await expect(makeRoom(scope, siblingType.id)).rejects.toEqual(rejectsWith('NOT_FOUND'));
    await expect(makeRoom(scope, typeId, { connectingRoomId: siblingRoom.id })).rejects.toEqual(
      rejectsWith('NOT_FOUND')
    );
  });

  it('pins the kind to the type: a room cannot claim a kind its type does not have', async () => {
    await expect(
      within(scope, (tx) =>
        tx.hotelRoom.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            roomTypeId: typeId,
            inventoryKind: 'ROOM',
            number: 'wrong-kind',
            statusChangedBy: scope.actorId,
          },
        })
      )
    ).rejects.toThrow();
  });

  it('provisions BED capacity atomically and represents UNIT as a room with no beds', async () => {
    const room = await makeRoom();
    expect(room.inventoryKind).toBe('BED');
    expect(room.beds.map((bed) => bed.label)).toEqual(['1', '2']);
    const unitType = await makeType(scope, 'UNIT');
    const unit = await makeRoom(scope, unitType.id);
    expect(unit.inventoryKind).toBe('UNIT');
    expect(unit.beds).toEqual([]);
    await expect(
      within(scope, (tx) =>
        tx.hotelBed.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            roomId: unit.id,
            label: '1',
            statusChangedBy: scope.actorId,
          },
        })
      )
    ).rejects.toThrow();
    await expect(
      within(scope, (tx) =>
        tx.hotelBed.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            roomId: room.id,
            label: '3',
            statusChangedBy: scope.actorId,
          },
        })
      )
    ).rejects.toThrow();
  });

  it('keeps dorm policies to BED rooms and retired types out of new rooms', async () => {
    const roomType = await makeType(scope, 'ROOM');
    await expect(makeRoom(scope, roomType.id, { genderPolicy: 'FEMALE' })).rejects.toEqual(
      rejectsWith('BAD_REQUEST')
    );
    // The CHECK says the same thing to a direct writer.
    await expect(
      within(scope, (tx) =>
        tx.hotelRoom.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            roomTypeId: roomType.id,
            inventoryKind: 'ROOM',
            number: 'policy-on-room',
            genderPolicy: 'MALE',
            statusChangedBy: scope.actorId,
          },
        })
      )
    ).rejects.toThrow();
    const dorm = await makeRoom(scope, typeId, { genderPolicy: 'FEMALE' });
    expect(dorm.genderPolicy).toBe('FEMALE');
    const retired = await makeType(scope, 'ROOM', undefined, false);
    await expect(makeRoom(scope, retired.id)).rejects.toEqual(rejectsWith('BAD_REQUEST'));
  });

  it('rejects type capacity changes and room/bed reparenting', async () => {
    const room = await makeRoom();
    await expect(
      within(scope, (tx) =>
        tx.hotelRoomType.update({ where: { id: typeId }, data: { bedsPerRoom: 3 } })
      )
    ).rejects.toThrow();
    const unitType = await makeType(scope, 'UNIT');
    await expect(
      within(scope, (tx) =>
        tx.hotelRoom.update({ where: { id: room.id }, data: { roomTypeId: unitType.id } })
      )
    ).rejects.toThrow();
    await expect(
      within(scope, (tx) =>
        tx.hotelBed.update({ where: { id: room.beds[0].id }, data: { roomId } })
      )
    ).rejects.toThrow();
  });

  it('pins SQL transition behavior including OCCUPIED refusal for room and bed', async () => {
    const statuses = [
      'VACANT_DIRTY',
      'VACANT_CLEAN',
      'INSPECTED',
      'OUT_OF_ORDER',
      'OUT_OF_SERVICE',
      'OCCUPIED',
    ] as const;
    await within(scope, async (tx) => {
      for (const from of statuses)
        for (const to of statuses) {
          const [result] = await tx.$queryRaw<
            { allowed: boolean }[]
          >`SELECT hotel_inventory_transition_allowed(${from}::"HotelRoomStatus", ${to}::"HotelRoomStatus") AS allowed`;
          expect(result.allowed).toBe(inventoryTransitionAllowed(from, to));
        }
    });
    const room = await makeRoom();
    await expect(
      within(scope, (tx) =>
        tx.hotelRoom.update({ where: { id: room.id }, data: { status: 'OCCUPIED' } })
      )
    ).rejects.toThrow();
    await expect(
      within(scope, (tx) =>
        tx.hotelBed.update({ where: { id: room.beds[0].id }, data: { status: 'OCCUPIED' } })
      )
    ).rejects.toThrow();
  });

  it('records actor and reason with each status change; history cannot be changed, deleted or forged', async () => {
    const room = await makeRoom();
    await within(
      scope,
      (tx) =>
        setInventoryStatus(tx, scope, 'bed', {
          id: room.beds[0].id,
          expectedStatus: 'VACANT_DIRTY',
          status: 'VACANT_CLEAN',
          reason: 'Cleaned',
        }),
      'Cleaned'
    );
    const event = await within(scope, (tx) =>
      tx.hotelRoomStatusEvent.findFirstOrThrow({
        where: { bedId: room.beds[0].id, toStatus: 'VACANT_CLEAN' },
      })
    );
    expect(event).toMatchObject({
      fromStatus: 'VACANT_DIRTY',
      toStatus: 'VACANT_CLEAN',
      actorId: scope.actorId,
      reason: 'Cleaned',
      roomId: room.id,
    });
    await expect(
      within(scope, (tx) =>
        tx.hotelRoomStatusEvent.update({ where: { id: event.id }, data: { reason: 'Rewrite' } })
      )
    ).rejects.toThrow();
    await expect(
      within(scope, (tx) => tx.hotelRoomStatusEvent.delete({ where: { id: event.id } }))
    ).rejects.toThrow();
    await expect(
      within(scope, (tx) =>
        tx.hotelRoomStatusEvent.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            roomId: room.id,
            toStatus: 'VACANT_CLEAN',
            actorId: scope.actorId,
            reason: 'Forged',
          },
        })
      )
    ).rejects.toThrow();
  });

  it('confines housekeeping to its statuses and reports a stale expected status as a conflict', async () => {
    const room = await makeRoom();
    await expect(
      within(scope, (tx) =>
        setInventoryStatus(
          tx,
          scope,
          'room',
          { id: room.id, expectedStatus: 'VACANT_DIRTY', status: 'OUT_OF_ORDER', reason: 'Leak' },
          HOUSEKEEPING_ROOM_STATUSES
        )
      )
    ).rejects.toEqual(rejectsWith('FORBIDDEN'));
    await within(scope, (tx) =>
      setInventoryStatus(
        tx,
        scope,
        'room',
        { id: room.id, expectedStatus: 'VACANT_DIRTY', status: 'VACANT_CLEAN', reason: 'Cleaned' },
        HOUSEKEEPING_ROOM_STATUSES
      )
    );
    await expect(
      within(scope, (tx) =>
        // A legal move from the stale status, so the conflict is the row's, not the matrix's.
        setInventoryStatus(tx, scope, 'room', {
          id: room.id,
          expectedStatus: 'VACANT_DIRTY',
          status: 'OUT_OF_ORDER',
          reason: 'Stale board',
        })
      )
    ).rejects.toEqual(rejectsWith('CONFLICT'));
    expect(
      await within(scope, (tx) =>
        tx.hotelRoomStatusEvent.count({ where: { roomId: room.id, bedId: null } })
      )
    ).toBe(2);
  });

  it('refuses absent actor/reason and rolls status plus history back on a later failure', async () => {
    const room = await makeRoom();
    for (const [actorId, reason] of [
      ['', 'Cleaned'],
      [scope.actorId, ''],
    ]) {
      await expect(
        within(
          { ...scope, actorId },
          (tx) => tx.hotelRoom.update({ where: { id: room.id }, data: { status: 'VACANT_CLEAN' } }),
          reason
        )
      ).rejects.toThrow();
    }
    await expect(
      within(scope, async (tx) => {
        await setInventoryStatus(tx, scope, 'room', {
          id: room.id,
          expectedStatus: 'VACANT_DIRTY',
          status: 'VACANT_CLEAN',
          reason: 'Cleaned',
        });
        throw new Error('Downstream failure');
      })
    ).rejects.toThrow('Downstream failure');
    const current = await within(scope, (tx) =>
      tx.hotelRoom.findFirstOrThrow({ where: { id: room.id }, include: { statusEvents: true } })
    );
    expect(current.status).toBe('VACANT_DIRTY');
    expect(current.statusEvents).toHaveLength(3); // room + two bed initial events only
  });

  it('rolls newly created room, beds and initial events back together', async () => {
    let createdId = '';
    await expect(
      within(scope, async (tx) => {
        createdId = (
          await createInventoryRoom(
            tx,
            scope,
            hotelRoomCreateInput.parse({
              roomTypeId: typeId,
              number: 'rolled-back',
              reason: 'Commissioned',
            })
          )
        ).id;
        throw new Error('Provisioning failure');
      })
    ).rejects.toThrow('Provisioning failure');
    expect(await within(scope, (tx) => tx.hotelRoom.count({ where: { id: createdId } }))).toBe(0);
    expect(await within(scope, (tx) => tx.hotelBed.count({ where: { roomId: createdId } }))).toBe(
      0
    );
    expect(
      await within(scope, (tx) => tx.hotelRoomStatusEvent.count({ where: { roomId: createdId } }))
    ).toBe(0);
  });

  it('allows exactly one concurrent status change from an expected state', async () => {
    const room = await makeRoom();
    const results = await Promise.allSettled(
      (['VACANT_CLEAN', 'OUT_OF_ORDER'] as const).map((status) =>
        within(scope, (tx) =>
          setInventoryStatus(tx, scope, 'room', {
            id: room.id,
            expectedStatus: 'VACANT_DIRTY',
            status,
            reason: 'Concurrent change',
          })
        )
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await within(scope, (tx) =>
        tx.hotelRoomStatusEvent.count({ where: { roomId: room.id, bedId: null } })
      )
    ).toBe(2);
  });

  it('serializes concurrent bed insertions against declared capacity', async () => {
    const type = await makeType(scope, 'BED', 1);
    const room = await within(scope, (tx) =>
      tx.hotelRoom.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          roomTypeId: type.id,
          inventoryKind: 'BED',
          number: 'capacity-race',
          statusChangedBy: scope.actorId,
        },
      })
    );
    const results = await Promise.allSettled(
      ['1', '2'].map((label) =>
        within(scope, (tx) =>
          tx.hotelBed.create({
            data: {
              organizationId: scope.organizationId,
              branchId: scope.branchId,
              roomId: room.id,
              label,
              statusChangedBy: scope.actorId,
            },
          })
        )
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await within(scope, (tx) => tx.hotelBed.count({ where: { roomId: room.id } }))).toBe(1);
  });

  it('excludes overlapping OOO/OOS blocks under concurrency, permits adjacency and attributed release', async () => {
    const room = await makeRoom();
    const input = {
      roomId: room.id,
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      reason: 'Repair',
    };
    const results = await Promise.allSettled(
      (['OUT_OF_ORDER', 'OUT_OF_SERVICE'] as const).map((kind) =>
        within(scope, (tx) => createInventoryBlock(tx, scope, { ...input, kind }))
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await within(scope, (tx) =>
      createInventoryBlock(tx, scope, {
        ...input,
        kind: 'OUT_OF_SERVICE',
        startDate: '2026-10-03',
        endDate: '2026-10-04',
        workOrderRef: 'WO-7',
      })
    );
    const block = await within(scope, (tx) =>
      tx.hotelRoomBlock.findFirstOrThrow({
        where: { ...inventoryWhere(scope), roomId: room.id, startDate: new Date(input.startDate) },
      })
    );
    await expect(
      within(scope, (tx) => tx.hotelRoomBlock.delete({ where: { id: block.id } }))
    ).rejects.toThrow();
    await expect(
      within(scope, (tx) =>
        tx.hotelRoomBlock.update({ where: { id: block.id }, data: { reason: 'Rewrite' } })
      )
    ).rejects.toThrow();
    const released = await within(scope, (tx) =>
      releaseInventoryBlock(tx, scope, { id: block.id, reason: 'Repair complete' })
    );
    expect(released).toMatchObject({ releasedBy: scope.actorId, releaseReason: 'Repair complete' });
    expect(released.releasedAt).not.toBeNull();
    const replay = await within({ ...scope, actorId: 'second_actor' }, (tx) =>
      releaseInventoryBlock(tx, scope, { id: block.id, reason: 'Retry' })
    );
    expect(replay).toEqual(released);
    await within(scope, (tx) =>
      createInventoryBlock(tx, scope, { ...input, kind: 'OUT_OF_ORDER' })
    );
  });

  it('holds the sellable-unit ceiling lock across the organization’s properties, not across tenants', async () => {
    // One transaction takes the organization's ceiling lock and holds it; a
    // sibling property's reservation must wait on it (the ceiling is shared),
    // while another organization's reservation must not (its key differs).
    let lockTaken!: () => void;
    let releaseLock!: () => void;
    const taken = new Promise<void>((resolve) => (lockTaken = resolve));
    const held = new Promise<void>((resolve) => (releaseLock = resolve));
    const holder = within(scope, async (tx) => {
      await lockSellableUnitCeiling(tx, scope.organizationId);
      lockTaken();
      await held;
      return 'released';
    });
    await taken;
    let siblingSettled = false;
    const contender = within(sibling, (tx) =>
      reserveSellableUnits(tx, sibling.organizationId, 1, 1_000)
    ).finally(() => {
      siblingSettled = true;
    });
    const stranger = within(other, (tx) =>
      reserveSellableUnits(tx, other.organizationId, 1, 1_000)
    );
    await expect(stranger).resolves.toBeGreaterThanOrEqual(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(siblingSettled).toBe(false);
    releaseLock();
    await expect(holder).resolves.toBe('released');
    await expect(contender).resolves.toBeGreaterThanOrEqual(0);
    expect(siblingSettled).toBe(true);
  });

  it('admits exactly one of two properties racing for the last sellable unit', async () => {
    const used = await within(scope, (tx) => sellableUnitsUsed(tx, scope.organizationId));
    const limit = used + 1;
    const types = await Promise.all([makeType(scope, 'ROOM'), makeType(sibling, 'ROOM')]);
    const results = await Promise.allSettled(
      [scope, sibling].map((s, index) =>
        within(s, async (tx) => {
          await reserveSellableUnits(tx, s.organizationId, 1, limit);
          return createInventoryRoom(
            tx,
            s,
            hotelRoomCreateInput.parse({
              roomTypeId: types[index]!.id,
              number: `ceiling-race-${index}`,
              reason: 'Commissioned',
            })
          );
        })
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const refusal = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refusal.reason).toEqual(rejectsWith('FORBIDDEN'));
    expect(refusal.reason.message).toContain(`up to ${limit}`);
    expect(await within(scope, (tx) => sellableUnitsUsed(tx, scope.organizationId))).toBe(limit);
  });
});
