/**
 * M4-L2 / C4 — unit tests for snapshot resolution through the M3 effective-menu
 * read model. Runs the REAL `order-pricing` resolver (and the REAL L1/M3
 * primitives it composes: menu-availability + price-lists) against a small
 * in-memory db so the availability/channel gate, the winning-price precedence
 * (override > publication list > base list), and modifier snapshotting are all
 * tested without a database.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  resolveItemSnapshot,
  resolveModifierSnapshots,
  resolveOrderPricingRefs,
} from './order-pricing';

const D = (v: string) => new Prisma.Decimal(v);
const AT = new Date('2026-08-19T12:00:00.000Z');
const PAST = new Date('2026-08-01T00:00:00.000Z');

type Config = {
  publication?: {
    id: string;
    menuId: string;
    priceListId: string | null;
    channels: string[];
    timezone?: string;
  } | null;
  menuItem?: {
    id: string;
    productId: string;
    variantId: string | null;
    displayName: string | null;
    menuId: string;
    productName: string;
  } | null;
  override?: { isAvailable: boolean; priceOverride: Prisma.Decimal | null } | null;
  windows?: Array<{
    menuItemId: string | null;
    daysOfWeek: number[];
    startMinutes: number;
    endMinutes: number;
  }>;
  exceptions?: Array<{ date: Date; isClosed: boolean }>;
  priceLists?: Record<
    string,
    { productId: string; variantId: string | null; price: Prisma.Decimal }[]
  >;
  defaultListId?: string | null;
  modifierOptions?: Array<{
    id: string;
    name: string;
    priceDelta: Prisma.Decimal;
    modifierGroupId: string;
  }>;
  productGroups?: Record<
    string,
    Array<{ id: string; name?: string; minSelect?: number; maxSelect?: number | null }>
  >;
};

function makeDb(config: Config): ScopedDb {
  const listVersion = (priceListId: string) => `${priceListId}_v1`;
  return {
    restaurantBranchMenuPublication: {
      findUnique: async () =>
        config.publication
          ? {
              id: config.publication.id,
              menuId: config.publication.menuId,
              priceListId: config.publication.priceListId,
              channels: config.publication.channels,
              branch: { timezone: config.publication.timezone ?? 'UTC' },
            }
          : null,
    },
    restaurantMenuItem: {
      findUnique: async () =>
        config.menuItem
          ? {
              id: config.menuItem.id,
              productId: config.menuItem.productId,
              variantId: config.menuItem.variantId,
              displayName: config.menuItem.displayName,
              section: { menuId: config.menuItem.menuId },
              product: { name: config.menuItem.productName },
            }
          : null,
    },
    restaurantBranchMenuItemOverride: {
      findFirst: async () => config.override ?? null,
    },
    restaurantMenuAvailabilityWindow: {
      findMany: async () => config.windows ?? [],
    },
    restaurantMenuAvailabilityException: {
      findMany: async () => config.exceptions ?? [],
    },
    restaurantPriceList: {
      findFirst: async () => (config.defaultListId ? { id: config.defaultListId } : null),
    },
    restaurantPriceListVersion: {
      findMany: async ({ where }: { where: { priceListId: string } }) =>
        config.priceLists && config.priceLists[where.priceListId]
          ? [
              {
                id: listVersion(where.priceListId),
                versionNumber: 1,
                effectiveFrom: PAST,
                status: 'ACTIVE',
              },
            ]
          : [],
    },
    restaurantPriceListEntry: {
      findMany: async ({ where }: { where: { priceListVersionId: string } }) => {
        const listId = where.priceListVersionId.replace(/_v1$/, '');
        const entries = config.priceLists?.[listId] ?? [];
        return entries.map((e, idx) => ({
          id: `${listId}_e${idx}`,
          productId: e.productId,
          variantId: e.variantId,
          price: e.price,
        }));
      },
    },
    restaurantModifierOption: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        (config.modifierOptions ?? []).filter((o) => where.id.in.includes(o.id)),
    },
    restaurantProductModifierGroup: {
      findMany: async ({ where }: { where: { productId: string } }) =>
        (config.productGroups?.[where.productId] ?? []).map((group) => ({
          modifierGroupId: group.id,
          modifierGroup: {
            name: group.name ?? group.id,
            minSelect: group.minSelect ?? 0,
            maxSelect: group.maxSelect ?? null,
          },
        })),
    },
  } as unknown as ScopedDb;
}

const basePublication = {
  id: 'pub_1',
  menuId: 'menu_1',
  priceListId: 'pl_pub',
  channels: [] as string[], // empty = every operational channel
};
const baseMenuItem = {
  id: 'mi_1',
  productId: 'prod_1',
  variantId: null,
  displayName: 'House Burger',
  menuId: 'menu_1',
  productName: 'Burger',
};

describe('resolveItemSnapshot', () => {
  it('freezes name + publication-list price for an available item', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: baseMenuItem,
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('12.50') }] },
    });
    const snapshot = await resolveItemSnapshot(db, {
      publicationId: 'pub_1',
      channel: 'DINE_IN',
      menuItemId: 'mi_1',
      at: AT,
    });
    expect(snapshot.name).toBe('House Burger');
    expect(snapshot.unitPrice.toString()).toBe('12.5');
    expect(snapshot.priceSource).toBe('PUBLICATION_LIST');
    expect(snapshot.taxAmount.toString()).toBe('0');
    expect(snapshot.serviceChargeAmount.toString()).toBe('0');
  });

  it('falls back to the product name when the menu item has no display name', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: { ...baseMenuItem, displayName: null },
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('9.00') }] },
    });
    const snapshot = await resolveItemSnapshot(db, {
      publicationId: 'pub_1',
      channel: 'DINE_IN',
      menuItemId: 'mi_1',
      at: AT,
    });
    expect(snapshot.name).toBe('Burger');
  });

  it('prefers an item price override over the price lists', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: baseMenuItem,
      override: { isAvailable: true, priceOverride: D('7.77') },
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('12.50') }] },
    });
    const snapshot = await resolveItemSnapshot(db, {
      publicationId: 'pub_1',
      channel: 'DINE_IN',
      menuItemId: 'mi_1',
      at: AT,
    });
    expect(snapshot.priceSource).toBe('OVERRIDE');
    expect(snapshot.unitPrice.toString()).toBe('7.77');
  });

  it('falls back to the org base list when the publication list has no entry', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: baseMenuItem,
      priceLists: {
        pl_pub: [],
        pl_base: [{ productId: 'prod_1', variantId: null, price: D('5.00') }],
      },
      defaultListId: 'pl_base',
    });
    const snapshot = await resolveItemSnapshot(db, {
      publicationId: 'pub_1',
      channel: 'DINE_IN',
      menuItemId: 'mi_1',
      at: AT,
    });
    expect(snapshot.priceSource).toBe('BASE_LIST');
    expect(snapshot.unitPrice.toString()).toBe('5');
  });

  it('rejects an item that is not published on the requested channel', async () => {
    const db = makeDb({
      publication: { ...basePublication, channels: ['TAKEAWAY'] },
      menuItem: baseMenuItem,
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('12.50') }] },
    });
    await expect(
      resolveItemSnapshot(db, {
        publicationId: 'pub_1',
        channel: 'DINE_IN',
        menuItemId: 'mi_1',
        at: AT,
      })
    ).rejects.toMatchObject({ reason: 'CHANNEL_NOT_PUBLISHED' });
  });

  it('rejects an item that does not belong to the publication menu', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: { ...baseMenuItem, menuId: 'other_menu' },
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('12.50') }] },
    });
    await expect(
      resolveItemSnapshot(db, {
        publicationId: 'pub_1',
        channel: 'DINE_IN',
        menuItemId: 'mi_1',
        at: AT,
      })
    ).rejects.toMatchObject({ reason: 'ITEM_NOT_ON_MENU' });
  });

  it('rejects an unavailable item (branch override hides it)', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: baseMenuItem,
      override: { isAvailable: false, priceOverride: null },
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('12.50') }] },
    });
    await expect(
      resolveItemSnapshot(db, {
        publicationId: 'pub_1',
        channel: 'DINE_IN',
        menuItemId: 'mi_1',
        at: AT,
      })
    ).rejects.toMatchObject({ reason: 'ITEM_UNAVAILABLE' });
  });

  it('rejects an item with no effective price', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: baseMenuItem,
      priceLists: { pl_pub: [] },
    });
    await expect(
      resolveItemSnapshot(db, {
        publicationId: 'pub_1',
        channel: 'DINE_IN',
        menuItemId: 'mi_1',
        at: AT,
      })
    ).rejects.toMatchObject({ reason: 'ITEM_NOT_PRICED' });
  });

  it('snapshots selected modifiers attached to the product', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: baseMenuItem,
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('12.50') }] },
      modifierOptions: [
        { id: 'opt_cheese', name: 'Cheese', priceDelta: D('1.00'), modifierGroupId: 'grp_1' },
      ],
      productGroups: { prod_1: [{ id: 'grp_1' }] },
    });
    const snapshot = await resolveItemSnapshot(db, {
      publicationId: 'pub_1',
      channel: 'DINE_IN',
      menuItemId: 'mi_1',
      modifierOptionIds: ['opt_cheese'],
      at: AT,
    });
    expect(snapshot.modifiers).toEqual([
      { modifierOptionId: 'opt_cheese', name: 'Cheese', priceDelta: D('1.00') },
    ]);
  });

  it('rejects a modifier not attached to the item product', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: baseMenuItem,
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('12.50') }] },
      modifierOptions: [
        { id: 'opt_x', name: 'Foreign', priceDelta: D('1.00'), modifierGroupId: 'grp_other' },
      ],
      productGroups: { prod_1: [{ id: 'grp_1' }] },
    });
    await expect(
      resolveItemSnapshot(db, {
        publicationId: 'pub_1',
        channel: 'DINE_IN',
        menuItemId: 'mi_1',
        modifierOptionIds: ['opt_x'],
        at: AT,
      })
    ).rejects.toMatchObject({ reason: 'MODIFIER_NOT_ATTACHED' });
  });

  it('rejects an item snapshot when a required modifier group is omitted', async () => {
    const db = makeDb({
      publication: basePublication,
      menuItem: baseMenuItem,
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('12.50') }] },
      productGroups: { prod_1: [{ id: 'grp_required', name: 'Cooking', minSelect: 1 }] },
    });

    await expect(
      resolveItemSnapshot(db, {
        publicationId: 'pub_1',
        channel: 'DINE_IN',
        menuItemId: 'mi_1',
        at: AT,
      })
    ).rejects.toMatchObject({ reason: 'MODIFIER_SELECTION_COUNT' });
  });
});

describe('resolveModifierSnapshots', () => {
  it('rejects an unknown modifier option', async () => {
    const db = makeDb({ modifierOptions: [], productGroups: { prod_1: [{ id: 'grp_1' }] } });
    await expect(resolveModifierSnapshots(db, 'prod_1', ['missing'])).rejects.toMatchObject({
      reason: 'MODIFIER_NOT_FOUND',
    });
  });

  it('rejects selecting the same option more than once', async () => {
    const db = makeDb({
      modifierOptions: [
        { id: 'opt_1', name: 'Cheese', priceDelta: D('-1.00'), modifierGroupId: 'grp_1' },
      ],
      productGroups: { prod_1: [{ id: 'grp_1', maxSelect: 2 }] },
    });
    const optionLookup = vi.spyOn(db.restaurantModifierOption, 'findMany');
    const attachmentLookup = vi.spyOn(db.restaurantProductModifierGroup, 'findMany');

    await expect(resolveModifierSnapshots(db, 'prod_1', ['opt_1', 'opt_1'])).rejects.toMatchObject(
      { reason: 'MODIFIER_DUPLICATE' }
    );
    expect(optionLookup).not.toHaveBeenCalled();
    expect(attachmentLookup).not.toHaveBeenCalled();
  });

  it('rejects omitting selections from a required attached group', async () => {
    const db = makeDb({
      productGroups: { prod_1: [{ id: 'grp_required', name: 'Cooking', minSelect: 1 }] },
    });

    await expect(resolveModifierSnapshots(db, 'prod_1', [])).rejects.toMatchObject({
      reason: 'MODIFIER_SELECTION_COUNT',
    });
  });

  it('rejects omitting a required group when another attached group is selected', async () => {
    const db = makeDb({
      modifierOptions: [
        { id: 'opt_cheese', name: 'Cheese', priceDelta: D('1.00'), modifierGroupId: 'grp_extra' },
      ],
      productGroups: {
        prod_1: [
          { id: 'grp_cooking', name: 'Cooking', minSelect: 1 },
          { id: 'grp_extra', name: 'Extras', maxSelect: 1 },
        ],
      },
    });

    await expect(resolveModifierSnapshots(db, 'prod_1', ['opt_cheese'])).rejects.toMatchObject({
      reason: 'MODIFIER_SELECTION_COUNT',
    });
  });

  it('rejects a non-empty selection below an attached group minimum', async () => {
    const db = makeDb({
      modifierOptions: [
        { id: 'opt_1', name: 'Mild', priceDelta: D('0'), modifierGroupId: 'grp_1' },
      ],
      productGroups: { prod_1: [{ id: 'grp_1', name: 'Sauce', minSelect: 2 }] },
    });

    await expect(resolveModifierSnapshots(db, 'prod_1', ['opt_1'])).rejects.toMatchObject({
      reason: 'MODIFIER_SELECTION_COUNT',
    });
  });

  it('rejects selections above an attached group maximum', async () => {
    const db = makeDb({
      modifierOptions: [
        { id: 'opt_1', name: 'Mild', priceDelta: D('0'), modifierGroupId: 'grp_1' },
        { id: 'opt_2', name: 'Hot', priceDelta: D('0'), modifierGroupId: 'grp_1' },
      ],
      productGroups: { prod_1: [{ id: 'grp_1', name: 'Sauce', maxSelect: 1 }] },
    });

    await expect(resolveModifierSnapshots(db, 'prod_1', ['opt_1', 'opt_2'])).rejects.toMatchObject(
      { reason: 'MODIFIER_SELECTION_COUNT' }
    );
  });

  it('rejects a selection when an attached group allows no selections', async () => {
    const db = makeDb({
      modifierOptions: [
        { id: 'opt_1', name: 'Cheese', priceDelta: D('1.00'), modifierGroupId: 'grp_1' },
      ],
      productGroups: { prod_1: [{ id: 'grp_1', name: 'Extras', maxSelect: 0 }] },
    });

    await expect(resolveModifierSnapshots(db, 'prod_1', ['opt_1'])).rejects.toMatchObject({
      reason: 'MODIFIER_SELECTION_COUNT',
    });
  });

  it('accepts selections at the exact bounds across multiple attached groups', async () => {
    const db = makeDb({
      modifierOptions: [
        { id: 'opt_hot', name: 'Hot', priceDelta: D('0'), modifierGroupId: 'grp_sauce' },
        { id: 'opt_mild', name: 'Mild', priceDelta: D('0'), modifierGroupId: 'grp_sauce' },
        { id: 'opt_cheese', name: 'Cheese', priceDelta: D('1.00'), modifierGroupId: 'grp_extra' },
      ],
      productGroups: {
        prod_1: [
          { id: 'grp_sauce', minSelect: 2, maxSelect: 2 },
          { id: 'grp_extra', minSelect: 1, maxSelect: 1 },
        ],
      },
    });

    await expect(
      resolveModifierSnapshots(db, 'prod_1', ['opt_cheese', 'opt_hot', 'opt_mild'])
    ).resolves.toEqual([
      { modifierOptionId: 'opt_cheese', name: 'Cheese', priceDelta: D('1.00') },
      { modifierOptionId: 'opt_hot', name: 'Hot', priceDelta: D('0') },
      { modifierOptionId: 'opt_mild', name: 'Mild', priceDelta: D('0') },
    ]);
  });

  it('accepts an empty optional group and an unbounded group', async () => {
    const db = makeDb({
      modifierOptions: [
        { id: 'opt_1', name: 'Olives', priceDelta: D('0.50'), modifierGroupId: 'grp_unbounded' },
        { id: 'opt_2', name: 'Peppers', priceDelta: D('0.50'), modifierGroupId: 'grp_unbounded' },
      ],
      productGroups: {
        prod_1: [
          { id: 'grp_optional', maxSelect: 1 },
          { id: 'grp_unbounded', minSelect: 1 },
        ],
      },
    });

    await expect(
      resolveModifierSnapshots(db, 'prod_1', ['opt_1', 'opt_2'])
    ).resolves.toHaveLength(2);
  });
});

describe('resolveOrderPricingRefs', () => {
  it('returns the effective price-list version to stamp on the order', async () => {
    const db = makeDb({
      publication: basePublication,
      priceLists: { pl_pub: [{ productId: 'prod_1', variantId: null, price: D('12.50') }] },
    });
    const refs = await resolveOrderPricingRefs(db, {
      publicationId: 'pub_1',
      channel: 'DINE_IN',
      at: AT,
    });
    expect(refs.publicationId).toBe('pub_1');
    expect(refs.priceListVersionId).toBe('pl_pub_v1');
  });

  it('returns a null version when the publication carries no price list', async () => {
    const db = makeDb({ publication: { ...basePublication, priceListId: null } });
    const refs = await resolveOrderPricingRefs(db, {
      publicationId: 'pub_1',
      channel: 'DINE_IN',
      at: AT,
    });
    expect(refs.priceListVersionId).toBeNull();
  });
});
