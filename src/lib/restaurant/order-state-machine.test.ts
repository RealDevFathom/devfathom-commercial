import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ORDER_PAYMENT_POLICY,
  KDS_DISPLAY_BY_ITEM_STATUS,
  DELIVERY_HANDOFF_ITEM_TRANSITIONS,
  ORDER_ITEM_STATUSES,
  ORDER_ITEM_TRANSITIONS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  OrderInvariantError,
  OrderTransitionError,
  type OrderItemStatus,
  type OrderStatus,
  assertCanEnterPaymentPending,
  assertCancellationCompensated,
  assertItemTransition,
  assertNoActiveItemsForTerminal,
  assertOrderStatusChange,
  assertOrderTransition,
  assertRemakesResolvedForTerminal,
  canHandOffItemOnDelivery,
  canTransitionItem,
  canTransitionOrder,
  deriveKitchenAggregate,
  isActiveItem,
  isResolvedItem,
  isSentItem,
  isTerminalItemStatus,
  isTerminalOrderStatus,
  toKdsDisplayStatus,
} from './order-state-machine';

describe('§11.1 status domains are exact', () => {
  it('defines exactly the nine order statuses in plan order', () => {
    expect(ORDER_STATUSES).toEqual([
      'DRAFT',
      'OPEN',
      'SENT',
      'IN_PREPARATION',
      'READY',
      'SERVED',
      'PAYMENT_PENDING',
      'CLOSED',
      'CANCELLED',
    ]);
  });

  it('defines exactly the seven order-item statuses in plan order', () => {
    expect(ORDER_ITEM_STATUSES).toEqual([
      'HELD',
      'QUEUED',
      'FIRING',
      'PREPARED',
      'SERVED',
      'REMAKE_REQUESTED',
      'VOIDED',
    ]);
  });

  it('every transition target is itself a member of the domain (no typos)', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      expect(ORDER_STATUSES).toContain(from as OrderStatus);
      for (const to of targets) expect(ORDER_STATUSES).toContain(to);
    }
    for (const [from, targets] of Object.entries(ORDER_ITEM_TRANSITIONS)) {
      expect(ORDER_ITEM_STATUSES).toContain(from as OrderItemStatus);
      for (const to of targets) expect(ORDER_ITEM_STATUSES).toContain(to);
    }
  });

  it('no transition map lists a self-edge (a status never transitions to itself)', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      expect(targets).not.toContain(from as OrderStatus);
    }
    for (const [from, targets] of Object.entries(ORDER_ITEM_TRANSITIONS)) {
      expect(targets).not.toContain(from as OrderItemStatus);
    }
  });
});

describe('order machine — every legal transition and every illegal pair', () => {
  // Exhaustive over the full 9×9 cross product: a pair is legal iff it is listed
  // in ORDER_TRANSITIONS, and canTransitionOrder / assert must agree exactly.
  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      const legal = (ORDER_TRANSITIONS[from] as readonly OrderStatus[]).includes(to);
      it(`${from} -> ${to} is ${legal ? 'legal' : 'illegal'}`, () => {
        expect(canTransitionOrder(from, to)).toBe(legal);
        if (legal) {
          expect(() => assertOrderTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertOrderTransition(from, to)).toThrow(OrderTransitionError);
        }
      });
    }
  }

  it('CLOSED and CANCELLED are terminal (no outgoing edges)', () => {
    expect(ORDER_TRANSITIONS.CLOSED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
    expect(isTerminalOrderStatus('CLOSED')).toBe(true);
    expect(isTerminalOrderStatus('CANCELLED')).toBe(true);
    expect(isTerminalOrderStatus('OPEN')).toBe(false);
  });

  it('every non-terminal order status can still be cancelled', () => {
    for (const from of ORDER_STATUSES) {
      if (isTerminalOrderStatus(from)) continue;
      expect(canTransitionOrder(from, 'CANCELLED')).toBe(true);
    }
  });

  it('CLOSED is reachable only from PAYMENT_PENDING', () => {
    for (const from of ORDER_STATUSES) {
      expect(canTransitionOrder(from, 'CLOSED')).toBe(from === 'PAYMENT_PENDING');
    }
  });

  it('PAYMENT_PENDING is reachable only from SERVED (pay-before-fulfilment off)', () => {
    for (const from of ORDER_STATUSES) {
      expect(canTransitionOrder(from, 'PAYMENT_PENDING')).toBe(from === 'SERVED');
    }
  });
});

describe('item machine — every legal transition and every illegal pair', () => {
  for (const from of ORDER_ITEM_STATUSES) {
    for (const to of ORDER_ITEM_STATUSES) {
      const legal = (ORDER_ITEM_TRANSITIONS[from] as readonly OrderItemStatus[]).includes(to);
      it(`${from} -> ${to} is ${legal ? 'legal' : 'illegal'}`, () => {
        expect(canTransitionItem(from, to)).toBe(legal);
        if (legal) {
          expect(() => assertItemTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertItemTransition(from, to)).toThrow(OrderTransitionError);
        }
      });
    }
  }

  it('VOIDED is the single terminal item state', () => {
    expect(ORDER_ITEM_TRANSITIONS.VOIDED).toEqual([]);
    expect(isTerminalItemStatus('VOIDED')).toBe(true);
    for (const status of ORDER_ITEM_STATUSES) {
      if (status === 'VOIDED') continue;
      expect(isTerminalItemStatus(status)).toBe(false);
    }
  });

  it('every non-terminal item can be voided (void is always available)', () => {
    for (const from of ORDER_ITEM_STATUSES) {
      if (from === 'VOIDED') continue;
      expect(canTransitionItem(from, 'VOIDED')).toBe(true);
    }
  });

  it('a remake stays linked and can re-queue, be accepted, or be voided', () => {
    expect(ORDER_ITEM_TRANSITIONS.REMAKE_REQUESTED).toEqual(['QUEUED', 'SERVED', 'VOIDED']);
    // A remake can be requested only off a prepared or served line.
    for (const from of ORDER_ITEM_STATUSES) {
      expect(canTransitionItem(from, 'REMAKE_REQUESTED')).toBe(
        from === 'PREPARED' || from === 'SERVED'
      );
    }
  });

  it('courses can be held and fired without touching one another (HELD <-> QUEUED)', () => {
    expect(canTransitionItem('HELD', 'QUEUED')).toBe(true);
    expect(canTransitionItem('QUEUED', 'HELD')).toBe(true);
  });
});

describe('item classification vocabulary', () => {
  it('resolved = SERVED or VOIDED; active = everything else', () => {
    for (const status of ORDER_ITEM_STATUSES) {
      const resolved = status === 'SERVED' || status === 'VOIDED';
      expect(isResolvedItem(status)).toBe(resolved);
      expect(isActiveItem(status)).toBe(!resolved);
    }
  });

  it('sent = every state except HELD and VOIDED', () => {
    for (const status of ORDER_ITEM_STATUSES) {
      expect(isSentItem(status)).toBe(status !== 'HELD' && status !== 'VOIDED');
    }
  });
});

describe('kitchen aggregate derivation (§11.1)', () => {
  it('returns null when nothing has been sent', () => {
    expect(deriveKitchenAggregate([])).toBeNull();
    expect(deriveKitchenAggregate(['HELD', 'HELD'])).toBeNull();
    expect(deriveKitchenAggregate(['VOIDED'])).toBeNull();
    expect(deriveKitchenAggregate(['HELD', 'VOIDED'])).toBeNull();
  });

  it('follows the least-advanced sent item', () => {
    expect(deriveKitchenAggregate(['QUEUED', 'SERVED'])).toBe('SENT');
    expect(deriveKitchenAggregate(['FIRING', 'PREPARED'])).toBe('IN_PREPARATION');
    expect(deriveKitchenAggregate(['PREPARED', 'PREPARED', 'SERVED'])).toBe('READY');
    expect(deriveKitchenAggregate(['SERVED', 'SERVED'])).toBe('SERVED');
  });

  it('a recall (REMAKE_REQUESTED) pulls the aggregate back to IN_PREPARATION', () => {
    expect(deriveKitchenAggregate(['SERVED', 'REMAKE_REQUESTED'])).toBe('IN_PREPARATION');
  });

  it('ignores voided and held items when computing the aggregate', () => {
    expect(deriveKitchenAggregate(['SERVED', 'VOIDED'])).toBe('SERVED');
    expect(deriveKitchenAggregate(['SERVED', 'HELD'])).toBe('SERVED');
    expect(deriveKitchenAggregate(['PREPARED', 'HELD', 'VOIDED'])).toBe('READY');
  });
});

describe('fixed KDS display mapping (§11.1)', () => {
  it('maps every item status to a fixed display status', () => {
    expect(KDS_DISPLAY_BY_ITEM_STATUS).toEqual({
      HELD: 'HELD',
      QUEUED: 'NEW',
      FIRING: 'COOKING',
      PREPARED: 'READY',
      SERVED: 'SERVED',
      REMAKE_REQUESTED: 'RECALLED',
      VOIDED: 'VOIDED',
    });
    for (const status of ORDER_ITEM_STATUSES) {
      expect(toKdsDisplayStatus(status)).toBe(KDS_DISPLAY_BY_ITEM_STATUS[status]);
    }
  });

  it('is total — no item status is left unmapped', () => {
    for (const status of ORDER_ITEM_STATUSES) {
      expect(toKdsDisplayStatus(status)).toBeDefined();
    }
  });
});

describe('§11.1 terminal invariant — no active item when order goes terminal', () => {
  it('permits a terminal order whose items are all resolved', () => {
    expect(() => assertNoActiveItemsForTerminal('CLOSED', ['SERVED', 'VOIDED'])).not.toThrow();
    expect(() => assertNoActiveItemsForTerminal('CANCELLED', ['VOIDED', 'VOIDED'])).not.toThrow();
  });

  it('rejects a terminal order that still holds an active item', () => {
    for (const active of ['HELD', 'QUEUED', 'FIRING', 'PREPARED', 'REMAKE_REQUESTED'] as const) {
      expect(() => assertNoActiveItemsForTerminal('CLOSED', ['SERVED', active])).toThrow(
        OrderInvariantError
      );
    }
  });

  it('is a no-op for non-terminal targets', () => {
    expect(() => assertNoActiveItemsForTerminal('SENT', ['QUEUED', 'FIRING'])).not.toThrow();
  });
});

describe('§11.1 cancellation compensation invariant', () => {
  it('rejects a cancelled order retaining queued/firing/prepared items', () => {
    for (const uncompensated of ['QUEUED', 'FIRING', 'PREPARED'] as const) {
      expect(() => assertCancellationCompensated('CANCELLED', [uncompensated])).toThrow(
        OrderInvariantError
      );
    }
  });

  it('permits a cancelled order once those items are voided', () => {
    expect(() => assertCancellationCompensated('CANCELLED', ['VOIDED', 'VOIDED'])).not.toThrow();
  });

  it('is a no-op for non-cancel targets', () => {
    expect(() => assertCancellationCompensated('CLOSED', ['QUEUED'])).not.toThrow();
  });
});

describe('§11.1 remake-resolution invariant', () => {
  it('blocks a terminal order with an unresolved remake', () => {
    expect(() =>
      assertRemakesResolvedForTerminal('CLOSED', ['SERVED', 'REMAKE_REQUESTED'])
    ).toThrow(OrderInvariantError);
    expect(() =>
      assertRemakesResolvedForTerminal('CANCELLED', ['VOIDED', 'REMAKE_REQUESTED'])
    ).toThrow(OrderInvariantError);
  });

  it('permits a terminal order once the remake resolves', () => {
    expect(() => assertRemakesResolvedForTerminal('CLOSED', ['SERVED', 'SERVED'])).not.toThrow();
  });
});

describe('§11.1 / C5 payment gate — pay-before-fulfilment disabled in M4', () => {
  it('rejects PAYMENT_PENDING while any item is unfulfilled by default', () => {
    for (const unfulfilled of [
      'HELD',
      'QUEUED',
      'FIRING',
      'PREPARED',
      'REMAKE_REQUESTED',
    ] as const) {
      expect(() => assertCanEnterPaymentPending(['SERVED', unfulfilled])).toThrow(
        OrderInvariantError
      );
    }
  });

  it('permits PAYMENT_PENDING once every item is served or voided', () => {
    expect(() => assertCanEnterPaymentPending(['SERVED', 'VOIDED'])).not.toThrow();
    expect(() => assertCanEnterPaymentPending(['SERVED', 'SERVED'])).not.toThrow();
  });

  it('the default policy disables pay-before-fulfilment', () => {
    expect(DEFAULT_ORDER_PAYMENT_POLICY.allowPayBeforeFulfilment).toBe(false);
  });

  it('an accepted pay-before-fulfilment policy lifts the gate', () => {
    expect(() =>
      assertCanEnterPaymentPending(['QUEUED', 'FIRING'], { allowPayBeforeFulfilment: true })
    ).not.toThrow();
  });
});

describe('assertOrderStatusChange composes edge + invariant checks', () => {
  it('rejects an illegal edge before touching invariants', () => {
    expect(() => assertOrderStatusChange('DRAFT', 'CLOSED', [])).toThrow(OrderTransitionError);
  });

  it('rejects a legal edge that violates the terminal invariant', () => {
    // SERVED -> CANCELLED is a legal edge, but an active item blocks it.
    expect(() => assertOrderStatusChange('SERVED', 'CANCELLED', ['QUEUED'])).toThrow(
      OrderInvariantError
    );
  });

  it('permits PAYMENT_PENDING only once all items are served', () => {
    expect(() =>
      assertOrderStatusChange('SERVED', 'PAYMENT_PENDING', ['SERVED', 'SERVED'])
    ).not.toThrow();
    expect(() => assertOrderStatusChange('SERVED', 'PAYMENT_PENDING', ['SERVED', 'HELD'])).toThrow(
      OrderInvariantError
    );
  });

  it('permits a clean close from PAYMENT_PENDING with all items resolved', () => {
    expect(() =>
      assertOrderStatusChange('PAYMENT_PENDING', 'CLOSED', ['SERVED', 'VOIDED'])
    ).not.toThrow();
  });
});

describe('delivery hand-off item transition', () => {
  it('hands off only items the kitchen has received', () => {
    for (const status of ORDER_ITEM_STATUSES) {
      expect(canHandOffItemOnDelivery(status)).toBe(
        status === 'QUEUED' || status === 'FIRING' || status === 'PREPARED'
      );
    }
    expect(DELIVERY_HANDOFF_ITEM_TRANSITIONS.HELD).toEqual([]);
    expect(DELIVERY_HANDOFF_ITEM_TRANSITIONS.REMAKE_REQUESTED).toEqual([]);
  });

  it('does not widen the kitchen item machine', () => {
    expect(canTransitionItem('QUEUED', 'SERVED')).toBe(false);
    expect(canTransitionItem('FIRING', 'SERVED')).toBe(false);
  });
});
