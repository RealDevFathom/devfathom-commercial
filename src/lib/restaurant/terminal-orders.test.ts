/**
 * M4-L4 — unit tests for the POS-terminal transport glue. These cover the pieces
 * that need no database: the strict input schemas (unknown fields rejected, not
 * stripped — C7), the device-scoped idempotency-key extraction, the attribution
 * envelope built from trusted transport values, the acting-operator gate, and the
 * domain-error → HTTP mapping that must not leak internals.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { CoAuthorizationError } from './co-authorization';
import { KitchenTicketError } from './kitchen-tickets';
import { OrderCommandError } from './orders';
import { OrderPricingError } from './order-pricing';
import { OrderInvariantError, OrderTransitionError } from './order-state-machine';
import {
  addItemBody,
  buildActor,
  fireBody,
  idempotencyKeyFromRequest,
  openOrderBody,
  orderErrorResponse,
  requireActingOperator,
  voidBody,
} from './terminal-orders';
import type { TerminalContext } from './terminal-auth';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://tenant.test/api/restaurant/orders/open', { method: 'POST', headers });
}

describe('strict input schemas (C7)', () => {
  it('accepts a well-formed open body and rejects an unknown field', () => {
    expect(openOrderBody.safeParse({ channel: 'DINE_IN', tableIds: ['t1'] }).success).toBe(true);
    const bad = openOrderBody.safeParse({ channel: 'DINE_IN', branchId: 'b1' });
    expect(bad.success).toBe(false); // branchId is transport-derived, never body
    expect(
      openOrderBody.safeParse({ channel: 'DINE_IN', serverStaffProfileId: 'staff-other' }).success
    ).toBe(false); // server defaults to the authenticated operator; reassignment is unsupported
  });

  it('requires a channel on open and a valid enum value', () => {
    expect(openOrderBody.safeParse({}).success).toBe(false);
    expect(openOrderBody.safeParse({ channel: 'EAT_IN' }).success).toBe(false);
  });

  it('treats fire course as optional (whole-order vs single-course fire)', () => {
    expect(fireBody.safeParse({ orderId: 'o1' }).success).toBe(true);
    expect(fireBody.safeParse({ orderId: 'o1', course: 2 }).success).toBe(true);
    expect(fireBody.safeParse({ orderId: 'o1', course: 0 }).success).toBe(false);
  });

  it('rejects an unknown field inside the nested void co-authorization block', () => {
    const ok = voidBody.safeParse({
      orderId: 'o1',
      itemId: 'i1',
      reason: 'dropped',
      approving: { staffProfileId: 'm1', type: 'PIN', secret: '9999' },
    });
    expect(ok.success).toBe(true);
    const bad = voidBody.safeParse({
      orderId: 'o1',
      itemId: 'i1',
      reason: 'dropped',
      approving: { staffProfileId: 'm1', type: 'PIN', secret: '9999', extra: true },
    });
    expect(bad.success).toBe(false);
  });

  it('requires a positive quantity on add-item when supplied', () => {
    expect(addItemBody.safeParse({ orderId: 'o1', menuItemId: 'm1' }).success).toBe(true);
    expect(addItemBody.safeParse({ orderId: 'o1', menuItemId: 'm1', quantity: 0 }).success).toBe(
      false
    );
  });
});

describe('idempotencyKeyFromRequest', () => {
  it('returns the trimmed key when present, null when absent or blank', () => {
    expect(idempotencyKeyFromRequest(req({ 'idempotency-key': 'abc-123' }))).toBe('abc-123');
    expect(idempotencyKeyFromRequest(req({ 'idempotency-key': '  key  ' }))).toBe('key');
    expect(idempotencyKeyFromRequest(req())).toBeNull();
    expect(idempotencyKeyFromRequest(req({ 'idempotency-key': '   ' }))).toBeNull();
  });
});

describe('buildActor', () => {
  it('assembles the attribution envelope from the trusted transport values', () => {
    expect(buildActor('staff_1', 'dev_1', 'key_1')).toEqual({
      staffProfileId: 'staff_1',
      deviceId: 'dev_1',
      idempotencyKey: 'key_1',
    });
  });
});

describe('requireActingOperator', () => {
  const ctx = (state: string, activeStaffProfileId: string | null) =>
    ({ state, session: { activeStaffProfileId } }) as unknown as TerminalContext;

  it('returns the acting operator for an unlocked terminal', () => {
    const result = requireActingOperator(ctx('UNLOCKED', 'staff_9'));
    expect(result).toEqual({ ok: true, staffProfileId: 'staff_9' });
  });

  it('rejects a locked terminal with a 409', () => {
    const result = requireActingOperator(ctx('LOCKED', null));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(409);
  });
});

describe('orderErrorResponse — domain error → HTTP status (no internals leaked)', () => {
  it('maps OrderCommandError reasons to 404 / 409 / 400', async () => {
    expect(orderErrorResponse(new OrderCommandError('x', 'ORDER_NOT_FOUND'))!.status).toBe(404);
    expect(orderErrorResponse(new OrderCommandError('x', 'TABLE_NOT_FOUND'))!.status).toBe(404);
    expect(orderErrorResponse(new OrderCommandError('x', 'ORDER_TERMINAL'))!.status).toBe(409);
    expect(orderErrorResponse(new OrderCommandError('x', 'ITEM_STATE'))!.status).toBe(409);
    expect(orderErrorResponse(new OrderCommandError('x', 'NOTHING_TO_SEND'))!.status).toBe(409);
    expect(orderErrorResponse(new OrderCommandError('x', 'CO_AUTH_REQUIRED'))!.status).toBe(400);
    expect(orderErrorResponse(new OrderCommandError('x', 'REASON_REQUIRED'))!.status).toBe(400);
  });

  it('maps OrderPricingError reasons to 404 / 409 / 400', () => {
    expect(orderErrorResponse(new OrderPricingError('x', 'PUBLICATION_NOT_FOUND'))!.status).toBe(
      404
    );
    expect(orderErrorResponse(new OrderPricingError('x', 'ITEM_NOT_ON_MENU'))!.status).toBe(404);
    expect(orderErrorResponse(new OrderPricingError('x', 'ITEM_UNAVAILABLE'))!.status).toBe(409);
    expect(orderErrorResponse(new OrderPricingError('x', 'ITEM_NOT_PRICED'))!.status).toBe(400);
  });

  it('maps state-machine + kitchen-ticket + co-auth errors', () => {
    expect(orderErrorResponse(new OrderTransitionError('x'))!.status).toBe(409);
    expect(orderErrorResponse(new OrderInvariantError('x'))!.status).toBe(409);
    expect(orderErrorResponse(new KitchenTicketError('x', 'NO_STATION'))!.status).toBe(409);
    expect(orderErrorResponse(new CoAuthorizationError('x'))!.status).toBe(400);
  });

  it('returns null for a non-domain error (route rethrows → generic 500)', () => {
    expect(orderErrorResponse(new Error('boom'))).toBeNull();
    expect(orderErrorResponse(new TypeError('nope'))).toBeNull();
  });

  it('carries the authored domain message through, verbatim', async () => {
    const res = orderErrorResponse(
      new OrderCommandError('The order does not exist.', 'ORDER_NOT_FOUND')
    )!;
    expect(await res.json()).toEqual({ error: 'The order does not exist.' });
  });
});
