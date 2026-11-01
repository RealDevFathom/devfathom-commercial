import { describe, expect, it, vi } from 'vitest';

import {
  HOUSEKEEPING_STATUSES,
  HOUSEKEEPING_TASK_LIST_LIMIT,
  canTransitionHousekeeping,
  createHousekeepingTask,
  housekeepingStatusInput,
  isRoomSellable,
  listHousekeeping,
  setHousekeepingStatus,
} from './housekeeping';
import { HOUSEKEEPING_ROOM_STATUSES } from './inventory';

const scope = { organizationId: 'org_1', branchId: 'branch_1', actorId: 'user_1' };
const sqlText = (query: unknown) => (query as { strings: readonly string[] }).strings.join('?');

describe('hotel housekeeping rules', () => {
  it('sets the room status itself, with exactly housekeeping’s subset of the PROP-03 matrix', () => {
    expect(HOUSEKEEPING_STATUSES).toEqual(['VACANT_CLEAN', 'VACANT_DIRTY', 'INSPECTED']);
    expect([...HOUSEKEEPING_STATUSES]).toEqual([...HOUSEKEEPING_ROOM_STATUSES]);
    expect(canTransitionHousekeeping('VACANT_DIRTY', 'VACANT_CLEAN')).toBe(true);
    expect(canTransitionHousekeeping('VACANT_CLEAN', 'INSPECTED')).toBe(true);
    expect(canTransitionHousekeeping('INSPECTED', 'VACANT_DIRTY')).toBe(true);
    expect(canTransitionHousekeeping('OUT_OF_ORDER', 'VACANT_CLEAN')).toBe(false);
    expect(canTransitionHousekeeping('INSPECTED', 'VACANT_CLEAN')).toBe(false);
    // An occupied room belongs to the stay lane: it can be neither cleaned nor dirtied here.
    expect(canTransitionHousekeeping('OCCUPIED', 'VACANT_CLEAN')).toBe(false);
    expect(canTransitionHousekeeping('VACANT_CLEAN', 'OCCUPIED')).toBe(false);
    // Withholding a room from sale is a block or an administrator's decision.
    expect(canTransitionHousekeeping('VACANT_DIRTY', 'OUT_OF_ORDER')).toBe(false);
  });

  it('excludes withheld rooms from availability', () => {
    expect(isRoomSellable('OUT_OF_ORDER')).toBe(false);
    expect(isRoomSellable('OUT_OF_SERVICE')).toBe(false);
    expect(isRoomSellable('VACANT_CLEAN')).toBe(true);
    expect(isRoomSellable('VACANT_DIRTY')).toBe(true);
    expect(isRoomSellable('INSPECTED')).toBe(true);
  });

  it('uses strict, money-free inputs and refuses a status outside its subset', () => {
    const base = { branchId: 'b', roomId: 'r', status: 'VACANT_CLEAN' };
    expect(housekeepingStatusInput.safeParse(base).success).toBe(true);
    expect(() => housekeepingStatusInput.parse({ ...base, amountMinor: 1 })).toThrow();
    expect(housekeepingStatusInput.safeParse({ ...base, status: 'OCCUPIED' }).success).toBe(false);
    expect(housekeepingStatusInput.safeParse({ ...base, status: 'OUT_OF_ORDER' }).success).toBe(false);
    // The retired parallel vocabulary is gone.
    expect(housekeepingStatusInput.safeParse({ ...base, status: 'CLEAN' }).success).toBe(false);
  });
});

describe('hotel housekeeping persistence', () => {
  it('reads room state from hotel_rooms.status and bounds the task list', async () => {
    const queries: string[] = [];
    const values: unknown[][] = [];
    const db = {
      $queryRaw: vi.fn(async (query: { strings: readonly string[]; values: unknown[] }) => {
        queries.push(sqlText(query));
        values.push(query.values);
        return [];
      }),
      $executeRaw: vi.fn(),
    };
    await listHousekeeping(db as never, scope);
    expect(queries[0]).toContain('r.status');
    expect(queries.join('\n')).not.toContain('hotel_room_housekeeping');
    expect(queries[1]).toContain('LIMIT');
    expect(values[1]).toContain(HOUSEKEEPING_TASK_LIST_LIMIT);
  });

  it('refuses to touch an occupied room before any write', async () => {
    const db = {
      $queryRaw: vi.fn(async () => [{ status: 'OCCUPIED' }]),
      $executeRaw: vi.fn(),
      hotelRoom: { findFirst: vi.fn(), updateMany: vi.fn() },
    };
    await expect(
      setHousekeepingStatus(db as never, scope, 'room_1', 'VACANT_CLEAN')
    ).rejects.toMatchObject({ name: 'HotelInventoryError', code: 'BAD_REQUEST' });
    expect(db.hotelRoom.updateMany).not.toHaveBeenCalled();
  });

  it('writes a legal change to hotel_rooms.status through the inventory engine', async () => {
    const db = {
      $queryRaw: vi.fn(async () => [{ status: 'VACANT_DIRTY' }]),
      $executeRaw: vi.fn(),
      hotelRoom: {
        findFirst: vi.fn(async () => ({ id: 'room_1', status: 'VACANT_DIRTY' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    await expect(
      setHousekeepingStatus(db as never, scope, 'room_1', 'VACANT_CLEAN')
    ).resolves.toEqual({ id: 'room_1', status: 'VACANT_CLEAN' });
    expect(db.hotelRoom.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        branchId: 'branch_1',
        id: 'room_1',
        status: 'VACANT_DIRTY',
      },
      data: { status: 'VACANT_CLEAN' },
    });
  });

  it('refuses an assignee who is not an active member of the organization', async () => {
    const queries: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (query: unknown) => {
        queries.push(sqlText(query));
        return [];
      }),
      $executeRaw: vi.fn(),
    };
    await expect(
      createHousekeepingTask(db as never, scope, {
        branchId: 'branch_1',
        roomId: 'room_1',
        title: 'Turn down',
        assignedToId: 'someone_else',
      })
    ).rejects.toThrow('ASSIGNEE_NOT_FOUND');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('FROM users');
    expect(queries[0]).toContain('"organizationId" =');
  });
});
