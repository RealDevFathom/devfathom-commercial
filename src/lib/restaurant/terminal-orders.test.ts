/**
 * M4-L4 — unit tests for the POS-terminal transport glue. These cover the pieces
 * that need no database: the strict input schemas (unknown fields rejected, not
 * stripped — C7), the device-scoped idempotency-key extraction, the attribution
 * envelope built from trusted transport values, the acting-operator gate, and the
 * domain-error → HTTP mapping that must not leak internals.
 */
import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

import { CoAuthorizationError } from './co-authorization';
import { KitchenTicketError } from './kitchen-tickets';
import { OrderCommandError } from './orders';
import { OrderPricingError } from './order-pricing';
import { OrderInvariantError, OrderTransitionError } from './order-state-machine';
import {
  addItemBody,
  buildActor,
  canonicalJson,
  effectiveMenuETag,
  effectiveMenuQuery,
  effectiveMenuVersion,
  fireBody,
  idempotencyKeyFromRequest,
  ifNoneMatchSatisfied,
  listOpenOrdersForBranch,
  openOrderBody,
  orderErrorResponse,
  requireActingOperator,
  requireOrderInDeviceBranch,
  resolveTerminalEffectiveMenu,
  voidBody,
  type TerminalEffectiveMenu,
} from './terminal-orders';
import type { TerminalContext } from './terminal-auth';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://tenant.test/api/restaurant/orders/open', { method: 'POST', headers });
}

describe('listOpenOrdersForBranch', () => {
  it('counts purchased units and excludes remakes from the subtotal', async () => {
    const db = {
      restaurantOrder: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'order_1',
            orderNumber: 42,
            businessDate: new Date('2026-08-18T00:00:00.000Z'),
            status: 'OPEN',
            channel: 'DINE_IN',
            coverCount: 1,
            sectionId: null,
            serverStaffProfileId: 'staff_1',
            openedAt: new Date('2026-08-18T12:00:00.000Z'),
            items: [{ unitPrice: new Prisma.Decimal('12.50'), quantity: 2, modifiers: [] }],
            orderTables: [],
          },
        ]),
      },
    } as unknown as ScopedDb;

    const result = await listOpenOrdersForBranch(db, 'branch_1');

    expect(result.orders[0]?.itemCount).toBe(2);
    expect(result.orders[0]?.subtotal).toBe('25');
    expect(db.restaurantOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          items: expect.objectContaining({
            where: { status: { not: 'VOIDED' }, remakeOfItemId: null },
          }),
        }),
      })
    );
  });
});

describe('strict input schemas (C7)', () => {
  it('accepts a well-formed open body and rejects an unknown field', () => {
    expect(openOrderBody.safeParse({ channel: 'DINE_IN', tableIds: ['t1'] }).success).toBe(true);
    const bad = openOrderBody.safeParse({ channel: 'DINE_IN', branchId: 'b1' });
    expect(bad.success).toBe(false); // branchId is transport-derived, never body
    expect(
      openOrderBody.safeParse({ channel: 'DINE_IN', serverStaffProfileId: 'staff-other' }).success
    ).toBe(false); // server defaults to the authenticated operator; reassignment is unsupported
  });

  it('requires a trusted customer and no table for delivery', () => {
    expect(openOrderBody.safeParse({ channel: 'DINE_IN' }).success).toBe(true);
    expect(openOrderBody.safeParse({ channel: 'TAKEAWAY' }).success).toBe(true);
    expect(openOrderBody.safeParse({}).success).toBe(false);
    expect(openOrderBody.safeParse({ channel: 'EAT_IN' }).success).toBe(false);
    expect(openOrderBody.safeParse({ channel: 'DELIVERY' }).success).toBe(false);
    expect(openOrderBody.safeParse({ channel: 'DELIVERY', customerId: 'customer_1' }).success).toBe(
      true
    );
    expect(
      openOrderBody.safeParse({
        channel: 'DELIVERY',
        customerId: 'customer_1',
        tableIds: ['table_1'],
      }).success
    ).toBe(false);
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

describe('requireOrderInDeviceBranch', () => {
  it('allows an order in the authenticated device branch', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'o1' });
    const db = { restaurantOrder: { findFirst } } as never;

    await expect(requireOrderInDeviceBranch(db, 'o1', 'branch_1')).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'o1', branchId: 'branch_1' },
      select: { id: true },
    });
  });

  it('makes a same-organization cross-branch order indistinguishable from missing', async () => {
    const db = {
      restaurantOrder: { findFirst: vi.fn().mockResolvedValue(null) },
    } as never;

    await expect(
      requireOrderInDeviceBranch(db, 'branch_2_order', 'branch_1')
    ).rejects.toMatchObject({
      reason: 'ORDER_NOT_FOUND',
      message: 'The order does not exist.',
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
    expect(orderErrorResponse(new OrderCommandError('x', 'IDEMPOTENCY_CONFLICT'))!.status).toBe(
      409
    );
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

// ── M9-L1: the effective-menu catalog contract (criterion 5) ─────────────────

describe('effectiveMenuQuery — STRICT device-authed query (C7)', () => {
  it('accepts the documented parameters', () => {
    expect(effectiveMenuQuery.safeParse({ channel: 'DINE_IN' }).success).toBe(true);
    expect(
      effectiveMenuQuery.safeParse({
        channel: 'TAKEAWAY',
        publicationId: 'pub-1',
        at: '2026-08-27T10:00:00.000Z',
      }).success
    ).toBe(true);
  });

  it('rejects an unknown search parameter instead of silently ignoring it', () => {
    const bad = effectiveMenuQuery.safeParse({ channel: 'DINE_IN', branchId: 'b1' });
    expect(bad.success).toBe(false); // branchId is device-derived, never the query
    expect(effectiveMenuQuery.safeParse({ channel: 'DINE_IN', at: 'yesterday' }).success).toBe(
      false
    );
    expect(effectiveMenuQuery.safeParse({ channel: 'DRIVE_THRU' }).success).toBe(false);
    expect(effectiveMenuQuery.safeParse({}).success).toBe(false);
    expect(effectiveMenuQuery.safeParse({ channel: 'DELIVERY' }).success).toBe(true);
  });
});

describe('canonicalJson', () => {
  it('serialises structurally identical values to identical bytes', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ n: { z: 1, a: [1, { y: 2, x: 3 }] } })).toBe(
      '{"n":{"a":[1,{"x":3,"y":2}],"z":1}}'
    );
  });

  it('keeps array order significant and normalises absent values', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson(new Date('2026-08-27T10:00:00.000Z'))).toBe('"2026-08-27T10:00:00.000Z"');
  });
});

describe('resolveTerminalEffectiveMenu — POS modifier contract', () => {
  it('projects linked modifier groups and ordered options into the terminal payload', async () => {
    const findPublication = vi.fn().mockResolvedValue({
      id: 'pub-1',
      channels: ['TAKEAWAY'],
      priceListId: null,
      branch: { id: 'branch-1', timezone: 'Asia/Karachi' },
      windows: [],
      exceptions: [],
      itemOverrides: [],
      menu: {
        id: 'menu-1',
        name: 'All day',
        nameLocalized: null,
        sections: [
          {
            id: 'section-1',
            name: 'Mains',
            nameLocalized: null,
            sortOrder: 0,
            items: [
              {
                id: 'item-1',
                productId: 'product-1',
                variantId: null,
                displayName: 'Burger',
                nameLocalized: null,
                sortOrder: 0,
                product: {
                  id: 'product-1',
                  name: 'Burger',
                  type: 'FOOD',
                  status: 'ACTIVE',
                  nameLocalized: null,
                  descriptionLocalized: null,
                  modifierGroups: [
                    {
                      modifierGroup: {
                        id: 'group-1',
                        name: 'Heat',
                        minSelect: 0,
                        maxSelect: 1,
                        options: [{ id: 'option-1', name: 'Spicy', priceDelta: '1.50' }],
                      },
                    },
                  ],
                },
                variant: null,
              },
            ],
          },
        ],
      },
    });
    const db = {
      restaurantBranchMenuPublication: { findFirst: findPublication },
      restaurantPriceList: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as ScopedDb;

    const menu = await resolveTerminalEffectiveMenu(db, {
      branchId: 'branch-1',
      channel: 'TAKEAWAY',
      publicationId: 'pub-1',
      at: new Date('2026-09-01T12:00:00.000Z'),
    });

    expect(findPublication).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pub-1', branchId: 'branch-1' } })
    );
    expect(
      findPublication.mock.calls[0]?.[0].select.menu.select.sections.select.items.select.product
        .select.modifierGroups.orderBy
    ).toEqual([{ sortOrder: 'asc' }, { createdAt: 'asc' }]);
    expect(menu?.sections[0]?.items[0]?.modifierGroups).toEqual([
      {
        id: 'group-1',
        name: 'Heat',
        minSelect: 0,
        maxSelect: 1,
        options: [{ id: 'option-1', name: 'Spicy', priceDelta: '1.50' }],
      },
    ]);
  });
});

describe('effectiveMenuVersion — deterministic catalog version', () => {
  const menu = (
    overrides: {
      price?: string | null;
      available?: boolean;
      channelOpen?: boolean;
      publicationId?: string;
      priceSource?: string;
    } = {}
  ) =>
    ({
      publicationId: overrides.publicationId ?? 'pub-1',
      branchId: 'branch-1',
      channel: 'DINE_IN',
      channelOpen: overrides.channelOpen ?? true,
      menu: { id: 'menu-1', name: 'All day', nameLocalized: { ur: 'سارا دن', en: 'All day' } },
      sections: [
        {
          id: 'sec-1',
          name: 'Grill',
          nameLocalized: null,
          sortOrder: 1,
          items: [
            {
              id: 'mi-1',
              productId: 'prod-1',
              variantId: null,
              displayName: 'Seekh Kebab',
              nameLocalized: null,
              sortOrder: 1,
              product: {
                id: 'prod-1',
                name: 'Seekh Kebab',
                type: 'FOOD',
                status: 'ACTIVE',
                nameLocalized: null,
                descriptionLocalized: null,
              },
              variant: null,
              price: overrides.price === undefined ? '450.00' : overrides.price,
              priceSource: overrides.priceSource ?? 'PUBLICATION_LIST',
              available: overrides.available ?? true,
            },
          ],
        },
      ],
    }) as unknown as TerminalEffectiveMenu;

  it('is stable across calls and across localized-blob key order', () => {
    const first = effectiveMenuVersion(menu());
    expect(effectiveMenuVersion(menu())).toBe(first);
    expect(first).toMatch(/^v1:[0-9a-f]{32}$/);

    const reordered = JSON.parse(JSON.stringify(menu())) as unknown as TerminalEffectiveMenu & {
      menu: { nameLocalized: Record<string, string> };
    };
    reordered.menu.nameLocalized = { en: 'All day', ur: 'سارا دن' };
    expect(effectiveMenuVersion(reordered)).toBe(first);
  });

  it('changes on a price, price-source, publication, channel or 86 change', () => {
    const base = effectiveMenuVersion(menu());
    expect(effectiveMenuVersion(menu({ price: '525.00' }))).not.toBe(base);
    expect(effectiveMenuVersion(menu({ price: null }))).not.toBe(base);
    expect(effectiveMenuVersion(menu({ priceSource: 'OVERRIDE' }))).not.toBe(base);
    expect(effectiveMenuVersion(menu({ available: false }))).not.toBe(base);
    expect(effectiveMenuVersion(menu({ channelOpen: false }))).not.toBe(base);
    expect(effectiveMenuVersion(menu({ publicationId: 'pub-2' }))).not.toBe(base);
  });

  it('changes when an item leaves the publication', () => {
    const emptied = JSON.parse(JSON.stringify(menu())) as unknown as TerminalEffectiveMenu;
    emptied.sections[0].items = [];
    expect(effectiveMenuVersion(emptied)).not.toBe(effectiveMenuVersion(menu()));
  });
});

describe('ETag negotiation', () => {
  it('wraps a version as a strong entity tag', () => {
    expect(effectiveMenuETag('v1:abc')).toBe('"v1:abc"');
  });

  it('matches the list, weak and wildcard forms of If-None-Match', () => {
    const etag = effectiveMenuETag('v1:abc');
    expect(ifNoneMatchSatisfied('"v1:abc"', etag)).toBe(true);
    expect(ifNoneMatchSatisfied('W/"v1:abc"', etag)).toBe(true);
    expect(ifNoneMatchSatisfied('"v1:zzz", "v1:abc"', etag)).toBe(true);
    expect(ifNoneMatchSatisfied('*', etag)).toBe(true);
  });

  it('does not match a stale or absent tag', () => {
    const etag = effectiveMenuETag('v1:abc');
    expect(ifNoneMatchSatisfied(null, etag)).toBe(false);
    expect(ifNoneMatchSatisfied('', etag)).toBe(false);
    expect(ifNoneMatchSatisfied('"v1:zzz"', etag)).toBe(false);
    expect(ifNoneMatchSatisfied('v1:abc', etag)).toBe(false); // unquoted is not a tag
  });
});
