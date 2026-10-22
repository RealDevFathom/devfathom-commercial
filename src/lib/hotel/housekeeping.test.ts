import { describe, expect, it } from 'vitest';

import {
  HOUSEKEEPING_STATUSES,
  canTransitionHousekeeping,
  housekeepingStatusInput,
  isRoomSellable,
} from './housekeeping';

describe('hotel housekeeping rules', () => {
  it('keeps the four-status contract and validates transitions on the server', () => {
    expect(HOUSEKEEPING_STATUSES).toEqual(['CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER']);
    expect(canTransitionHousekeeping('DIRTY', 'CLEAN')).toBe(true);
    expect(canTransitionHousekeeping('CLEAN', 'INSPECTED')).toBe(true);
    expect(canTransitionHousekeeping('OUT_OF_ORDER', 'CLEAN')).toBe(false);
    expect(canTransitionHousekeeping('INSPECTED', 'CLEAN')).toBe(false);
  });

  it('excludes out-of-order rooms from availability', () => {
    expect(isRoomSellable('OUT_OF_ORDER')).toBe(false);
    expect(isRoomSellable('CLEAN')).toBe(true);
    expect(isRoomSellable('DIRTY')).toBe(true);
    expect(isRoomSellable('INSPECTED')).toBe(true);
  });

  it('uses strict, money-free inputs', () => {
    expect(() =>
      housekeepingStatusInput.parse({ branchId: 'b', roomId: 'r', status: 'CLEAN', amountMinor: 1 })
    ).toThrow();
  });
});
