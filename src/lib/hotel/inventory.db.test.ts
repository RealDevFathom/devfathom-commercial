import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PrismaClient } from '@/generated/prisma/client';
import {
  createInventoryBlock,
  createInventoryRoom,
  hotelRoomCreateInput,
  hotelRoomTypeCreateInput,
  inventoryTransitionAllowed,
  releaseInventoryBlock,
  setInventoryStatus,
  withHotelInventory,
  type HotelInventoryScope,
} from './inventory';

const runtimeUrl = process.env.HOTEL_INVENTORY_TEST_RUNTIME_DATABASE_URL;
if (!runtimeUrl) throw new Error('HOTEL_INVENTORY_TEST_RUNTIME_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(runtimeUrl).hostname)) {
  throw new Error('Inventory tests require a local disposable database');
}
process.env.DATABASE_URL = runtimeUrl;
const suffix = randomBytes(6).toString('hex');
const scope: HotelInventoryScope = {
  organizationId: `hotel_inventory_a_${suffix}`,
  branchId: '',
  actorId: `actor_${suffix}`,
};
const sibling = { ...scope };
const other = { ...scope, organizationId: `hotel_inventory_b_${suffix}` };
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

function within<T>(
  s: HotelInventoryScope,
  run: (db: PrismaClient) => Promise<T>,
  reason = 'Inventory test'
) {
  return withTenantDb(s.organizationId, (tx) => withHotelInventory(tx, s, reason, run));
}
async function makeType(
  s: HotelInventoryScope,
  inventoryKind: 'ROOM' | 'BED' | 'UNIT' = 'ROOM',
  bedsPerRoom?: number
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
      },
    })
  );
}
async function makeRoom(s = scope, roomTypeId = typeId) {
  return within(s, (tx) =>
    createInventoryRoom(
      tx,
      s,
      hotelRoomCreateInput.parse({
        roomTypeId,
        number: randomBytes(5).toString('hex'),
        reason: 'Commissioned',
      })
    )
  );
}

beforeAll(async () => {
  const client = new pg.Client({ connectionString: runtimeUrl });
  await client.connect();
  try {
    const posture = await client.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(posture.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  } finally {
    await client.end();
  }
  ({ withTenantDb } = await import('@/lib/tenancy/scoped-db'));
  ({ db } = await import('@/lib/db'));
  // Reuse property.db.test.ts's minimal, tenant-scoped property fixture; no root seed.
  for (const s of [scope, sibling, other]) {
    const property = await withTenantDb(s.organizationId, (tx) =>
      tx.hotelProperty.create({
        data: {
          organizationId: s.organizationId,
          name: 'Inventory fixture',
          addressLine: 'Fixture street',
          city: 'Lahore',
          timezone: 'Asia/Karachi',
          bookingEngineSlug: `inventory-${randomBytes(6).toString('hex')}`,
        },
      })
    );
    s.branchId = property.branchId;
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
}, 30_000);

afterAll(async () => {
  if (db) await db.$disconnect();
});

describe('inventory with restricted runtime and forced RLS', () => {
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
    '%s hides sibling properties and other tenants without query filters',
    async (table) => {
      for (const s of [scope, sibling, other]) {
        const rows = await within(s, (tx) =>
          tx.$queryRawUnsafe<{ organizationId: string; branchId: string }[]>(
            `SELECT "organizationId", "branchId" FROM "${table}"`
          )
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(
          rows.every(
            (row) => row.organizationId === s.organizationId && row.branchId === s.branchId
          )
        ).toBe(true);
      }
      const unscoped = await withTenantDb(scope.organizationId, (tx) =>
        tx.$queryRawUnsafe(`SELECT * FROM "${table}"`)
      );
      expect(unscoped).toEqual([]);
    }
  );

  it('refuses forged tenant/property writes and cross-property relationships', async () => {
    for (const forged of [sibling, other]) {
      await expect(
        within(scope, (tx) =>
          tx.hotelRoomType.create({
            data: {
              organizationId: forged.organizationId,
              branchId: forged.branchId,
              code: 'FORGED',
              name: 'Forged',
            },
          })
        )
      ).rejects.toThrow();
    }
    const siblingType = await makeType(sibling);
    await expect(
      within(scope, (tx) =>
        tx.hotelRoom.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            roomTypeId: siblingType.id,
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
            number: 'bad-connection',
            connectingRoomId: siblingRoom.id,
            statusChangedBy: scope.actorId,
          },
        })
      )
    ).rejects.toThrow();
  });

  it('provisions BED capacity atomically and represents UNIT as a room with no beds', async () => {
    const room = await makeRoom();
    expect(room.beds.map((bed) => bed.label)).toEqual(['1', '2']);
    const unitType = await makeType(scope, 'UNIT');
    const unit = await makeRoom(scope, unitType.id);
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
      })
    );
    const block = await within(scope, (tx) =>
      tx.hotelRoomBlock.findFirstOrThrow({
        where: { roomId: room.id, startDate: new Date(input.startDate) },
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
});
