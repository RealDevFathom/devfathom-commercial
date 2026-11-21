import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  COUNTER_ERROR_MESSAGES,
  counterErrorMessage,
  COUNTER_UNKNOWN_ERROR_MESSAGE,
} from './counter-messages';
import {
  cashShiftRefusal,
  handoverPharmacyDrawer,
  PharmacySettlementError,
  recordPharmacyCashMovement,
  withCashShiftRefusal,
} from './settlement';
import { closePharmacyCashShift, openPharmacyCashShift } from './cash-shifts';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

describe('DEV-958B cash-shift refusals', () => {
  it('turns each database guard into the typed reason the counter words', () => {
    for (const [message, reason] of [
      ['PHARMACY_SHIFT_NOT_OPEN: open a shift on this counter first', 'SHIFT_NOT_OPEN'],
      ['PHARMACY_SHIFT_OTHER_DAY: the open shift is on another business day', 'SHIFT_OTHER_DAY'],
      ['PHARMACY_SHIFT_OPEN: close every shift of the day before the day', 'SHIFT_OPEN'],
      [
        'PHARMACY_SHIFT_COUNT_MISMATCH: the drawer closes on its last shift',
        'SHIFT_COUNT_MISMATCH',
      ],
      ['PHARMACY_SHIFT_EXPECTED_MISMATCH: the shift changed; count again', 'SHIFT_CHANGED'],
    ] as const)
      expect(cashShiftRefusal(new Error(`ERROR: ${message}`))).toMatchObject({ reason });
    // Anything else is left alone.
    expect(cashShiftRefusal(new Error('PHARMACY_SHIFT_IMMUTABLE: a closed cash shift'))).toBeNull();
    expect(cashShiftRefusal('PHARMACY_SHIFT_NOT_OPEN:')).toBeNull();
  });

  it('rethrows an unrelated failure unchanged', async () => {
    const failure = new Error('connection reset');
    await expect(withCashShiftRefusal(Promise.reject(failure))).rejects.toBe(failure);
  });

  it('says plainly that an approval was refused or locked, never that one is still needed', () => {
    const asked = COUNTER_ERROR_MESSAGES.SHIFT_APPROVAL_REQUIRED;
    for (const reason of ['SHIFT_APPROVAL_REFUSED', 'SHIFT_APPROVAL_LOCKED'] as const)
      expect(COUNTER_ERROR_MESSAGES[reason], reason).not.toBe(asked);
    expect(COUNTER_ERROR_MESSAGES.SHIFT_APPROVAL_REFUSED).toMatch(/^That approval was refused/);
    expect(COUNTER_ERROR_MESSAGES.SHIFT_APPROVAL_LOCKED).toMatch(/locked/i);
  });

  it('has an operator sentence for every shift reason', () => {
    for (const reason of [
      'SHIFTS_NOT_ENABLED',
      'SHIFT_NOT_FOUND',
      'SHIFT_NOT_OPEN',
      'SHIFT_OTHER_DAY',
      'SHIFT_OPEN',
      'SHIFT_ALREADY_OPEN',
      'SHIFT_ALREADY_CLOSED',
      'SHIFT_NOTE_REQUIRED',
      'SHIFT_APPROVAL_REQUIRED',
      'SHIFT_COUNT_MISMATCH',
      'SHIFT_CHANGED',
      'SHIFT_HANDOVER_BY_CLOSE',
      'SHIFT_APPROVAL_REFUSED',
      'SHIFT_APPROVAL_LOCKED',
      'SHIFT_APPROVAL_NEEDS_ANOTHER',
      'SHIFT_APPROVAL_NOT_ELIGIBLE',
    ] as const) {
      expect(COUNTER_ERROR_MESSAGES[reason], reason).toBeTruthy();
      expect(counterErrorMessage(new PharmacySettlementError(reason))).not.toBe(
        COUNTER_UNKNOWN_ERROR_MESSAGE
      );
    }
  });
});

function drawerDb(drawer: Record<string, unknown>) {
  return {
    $queryRaw: vi.fn(async () => []),
    pharmacyDailyClose: { findFirst: vi.fn(async () => null) },
    pharmacyDrawerSession: { findFirst: vi.fn(async () => drawer), update: vi.fn() },
    pharmacyDrawerHandover: { create: vi.fn() },
    pharmacyDrawerMovement: { create: vi.fn() },
    pharmacyCashShift: { findMany: vi.fn(async () => []), findFirst: vi.fn(), create: vi.fn() },
    pharmacyBranch: { findFirst: vi.fn(async () => ({ businessDayEndsAtHistory: [] })) },
    organization: { findUnique: vi.fn(async () => ({ timezone: 'UTC' })) },
  };
}

describe('DEV-958B shifts on the drawer model', () => {
  it('hands a shift drawer over only by closing one shift and opening the next', async () => {
    const db = drawerDb({
      id: 'd',
      businessDate: new Date(),
      status: 'OPEN',
      cashShifts: true,
      openedByActorId: 'x',
    });
    await expect(
      handoverPharmacyDrawer(db as never, scope, {
        drawerSessionId: 'd',
        toCashierId: 'cashier-b',
        reason: 'Lunch',
      })
    ).rejects.toMatchObject({ reason: 'SHIFT_HANDOVER_BY_CLOSE' });
    expect(db.pharmacyDrawerHandover.create).not.toHaveBeenCalled();
  });

  it('keeps a drawer without shifts handing over as before', async () => {
    const db = drawerDb({
      id: 'd',
      businessDate: new Date(),
      status: 'OPEN',
      openedByActorId: 'x',
    });
    db.pharmacyDrawerHandover.create.mockResolvedValue({ id: 'h' } as never);
    db.pharmacyDrawerSession.update.mockResolvedValue({ id: 'd' } as never);
    await handoverPharmacyDrawer(
      db as never,
      { ...scope, actorId: 'manager' },
      {
        drawerSessionId: 'd',
        toCashierId: 'x',
        reason: 'Same cashier',
      }
    );
    expect(db.pharmacyDrawerHandover.create).not.toHaveBeenCalled();
  });

  it("refuses an online paid-in on an earlier day's open drawer", async () => {
    const db = drawerDb({
      id: 'd',
      businessDate: new Date('2020-01-01T00:00:00.000Z'),
      status: 'OPEN',
      openedByActorId: 'cashier-a',
    });
    await expect(
      recordPharmacyCashMovement(
        db as never,
        scope,
        {
          drawerSessionId: 'd',
          kind: 'PAID_IN',
          amountMinor: 100,
          reason: 'x',
          requireCurrentBusinessDate: true,
        },
        { kind: 'COUNTER', actorIsManager: true }
      )
    ).rejects.toMatchObject({ reason: 'DRAWER_FROM_EARLIER_DAY' });
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a shift on a drawer whose branch runs no shifts', async () => {
    const db = drawerDb({ id: 'd', businessDate: new Date(), status: 'OPEN', cashShifts: false });
    await expect(
      openPharmacyCashShift(
        db as never,
        scope,
        { drawerSessionId: 'd', openingFloatMinor: 0 },
        { actorIsManager: false }
      )
    ).rejects.toMatchObject({ reason: 'SHIFTS_NOT_ENABLED' });
    expect(db.pharmacyCashShift.create).not.toHaveBeenCalled();
  });

  it("refuses a cashier closing another cashier's shift", async () => {
    const db = drawerDb({});
    db.pharmacyCashShift.findFirst.mockResolvedValue({
      id: 's',
      businessDate: new Date(),
      cashierId: 'cashier-b',
      status: 'OPEN',
    } as never);
    await expect(
      closePharmacyCashShift(
        db as never,
        scope,
        { shiftId: 's', countedCashMinor: 0 },
        { actorIsManager: false }
      )
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_YOURS' });
  });

  it('refuses a negative or fractional count before reading anything', async () => {
    const db = drawerDb({});
    for (const countedCashMinor of [-1, 1.5])
      await expect(
        closePharmacyCashShift(
          db as never,
          scope,
          { shiftId: 's', countedCashMinor },
          { actorIsManager: true }
        )
      ).rejects.toMatchObject({ reason: 'INVALID_AMOUNT' });
    expect(db.pharmacyCashShift.findFirst).not.toHaveBeenCalled();
  });
});
