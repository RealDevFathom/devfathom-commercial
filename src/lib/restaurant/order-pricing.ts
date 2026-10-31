import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  channelPublished,
  isItemAvailableAt,
  partitionWindows,
  type AvailabilityException,
  type AvailabilityWindow,
  type OrderChannel,
} from './menu-availability';
import {
  pickEntry,
  resolveEffectiveEntries,
  resolveEffectivePriceListVersion,
} from './price-lists';

/**
 * M4-L2 / C4 — snapshot resolution through the M3 effective-menu read model.
 *
 * Adding an item to an order FREEZES what the guest is charged and shown: the
 * item's display name, its unit price, the selected modifier options (with their
 * price deltas), and the structurally-present-but-zero tax/service-charge fields
 * (the later payments/tax milestone fills them — BUILD-ASSUMPTIONS). Resolution
 * runs through exactly the same M3 primitives the router's `effectiveMenu` read
 * model uses — availability windows/exceptions/channel (`menu-availability.ts`)
 * and price-list precedence (`price-lists.ts`) — so an order can never snapshot a
 * price or availability the published menu would not have shown at that instant.
 * We deliberately do NOT import the router's private `buildEffectiveMenu`
 * (crossing the lib→router boundary, and M3 internals are consumed-not-modified,
 * C9); instead this resolves a SINGLE menu item against the shared primitives.
 *
 * Snapshot immutability (a named check): every value returned here is COPIED onto
 * the order item by the command layer and never re-read, so a later catalog,
 * menu, price-list or override edit cannot rewrite an order's history (C4).
 *
 * The module reads (it needs the catalog rows) but writes nothing; the command
 * layer persists the returned snapshot inside its own transaction.
 */

export type OrderPricingErrorReason =
  | 'PUBLICATION_NOT_FOUND'
  | 'CHANNEL_NOT_PUBLISHED'
  | 'ITEM_NOT_ON_MENU'
  | 'ITEM_UNAVAILABLE'
  | 'ITEM_NOT_PRICED'
  | 'MODIFIER_NOT_FOUND'
  | 'MODIFIER_NOT_ATTACHED'
  | 'MODIFIER_DUPLICATE'
  | 'MODIFIER_SELECTION_COUNT';

export class OrderPricingError extends Error {
  constructor(
    message: string,
    readonly reason: OrderPricingErrorReason
  ) {
    super(message);
    this.name = 'OrderPricingError';
  }
}

/** Where the winning unit price came from (mirrors the router read model). */
export type PriceSource = 'OVERRIDE' | 'PUBLICATION_LIST' | 'BASE_LIST';

/** A frozen modifier selection: the option's name + price delta at add time. The
 * `modifierOptionId` link is retained as the nullable convenience reference the
 * schema carries, but the copied name/delta are authoritative (C4). */
export type ResolvedModifierSnapshot = {
  modifierOptionId: string;
  name: string;
  priceDelta: Prisma.Decimal;
};

/** The frozen result of resolving one menu item for one order at one instant. */
export type ResolvedItemSnapshot = {
  productId: string;
  variantId: string | null;
  /** Display name = menu-item display name if set, else the product's name. */
  name: string;
  unitPrice: Prisma.Decimal;
  priceSource: PriceSource;
  modifiers: ResolvedModifierSnapshot[];
  /** Zero in M4 — the fields are structurally present; the tax milestone fills
   * them (C4 / BUILD-ASSUMPTIONS). */
  taxAmount: Prisma.Decimal;
  serviceChargeAmount: Prisma.Decimal;
};

/** The publication + price-list-version references an order stamps at open (C4). */
export type ResolvedOrderPricingRefs = {
  publicationId: string;
  /** The effective version of the publication's own price list at the open
   * instant, or null when the publication carries no price list (the base
   * default list then governs per-item pricing). */
  priceListVersionId: string | null;
};

const ZERO = new Prisma.Decimal(0);

type PublicationRow = {
  id: string;
  menuId: string;
  priceListId: string | null;
  channels: OrderChannel[];
  branch: { timezone: string };
};

/** Load a publication scoped to the caller's org (RLS), or throw NOT_FOUND. */
async function loadPublication(db: ScopedDb, publicationId: string): Promise<PublicationRow> {
  const publication = await db.restaurantBranchMenuPublication.findUnique({
    where: { id: publicationId },
    select: {
      id: true,
      menuId: true,
      priceListId: true,
      channels: true,
      branch: { select: { timezone: true } },
    },
  });
  if (!publication) {
    throw new OrderPricingError(
      'The order references a menu publication that does not exist.',
      'PUBLICATION_NOT_FOUND'
    );
  }
  return publication as PublicationRow;
}

/**
 * Resolve the publication + price-list-version references to stamp on an order at
 * open (C4). Validates the publication exists and publishes the order's channel.
 */
export async function resolveOrderPricingRefs(
  db: ScopedDb,
  input: { publicationId: string; channel: OrderChannel; at: Date }
): Promise<ResolvedOrderPricingRefs> {
  const publication = await loadPublication(db, input.publicationId);
  if (!channelPublished(publication.channels, input.channel)) {
    throw new OrderPricingError(
      `The menu publication is not offered on the ${input.channel} channel.`,
      'CHANNEL_NOT_PUBLISHED'
    );
  }
  const version = publication.priceListId
    ? await resolveEffectivePriceListVersion(db, publication.priceListId, input.at)
    : null;
  return { publicationId: publication.id, priceListVersionId: version?.id ?? null };
}

export type ResolveItemSnapshotInput = {
  publicationId: string;
  channel: OrderChannel;
  menuItemId: string;
  modifierOptionIds?: readonly string[];
  at: Date;
};

/**
 * Resolve a single menu item into the frozen snapshot the command layer writes.
 * Mirrors the router's effective-menu precedence exactly: an item is available
 * only when the channel is published, the branch-timezone availability windows
 * and exceptions allow it, and the branch override does not hide it; the winning
 * price is item-override > publication price list > base (org-default) price list,
 * all resolved at instant `at`. Throws {@link OrderPricingError} when the item is
 * off-menu, unavailable, or unpriced — a POS may never send an item the menu did
 * not offer.
 */
export async function resolveItemSnapshot(
  db: ScopedDb,
  input: ResolveItemSnapshotInput
): Promise<ResolvedItemSnapshot> {
  const publication = await loadPublication(db, input.publicationId);
  if (!channelPublished(publication.channels, input.channel)) {
    throw new OrderPricingError(
      `The menu publication is not offered on the ${input.channel} channel.`,
      'CHANNEL_NOT_PUBLISHED'
    );
  }

  const menuItem = await db.restaurantMenuItem.findUnique({
    where: { id: input.menuItemId },
    select: {
      id: true,
      productId: true,
      variantId: true,
      displayName: true,
      section: { select: { menuId: true } },
      product: { select: { name: true } },
    },
  });
  if (!menuItem || menuItem.section.menuId !== publication.menuId) {
    throw new OrderPricingError(
      'The menu item does not belong to the order’s menu publication.',
      'ITEM_NOT_ON_MENU'
    );
  }

  // Availability: the branch override, then the publication/item window layers,
  // evaluated in the branch timezone at `at` (client time is never trusted, C5).
  const override = await db.restaurantBranchMenuItemOverride.findFirst({
    where: { publicationId: publication.id, menuItemId: menuItem.id },
    select: { isAvailable: true, priceOverride: true },
  });
  const windows = await db.restaurantMenuAvailabilityWindow.findMany({
    where: { publicationId: publication.id },
    select: { menuItemId: true, daysOfWeek: true, startMinutes: true, endMinutes: true },
  });
  const exceptions = await db.restaurantMenuAvailabilityException.findMany({
    where: { publicationId: publication.id },
    select: { date: true, isClosed: true },
  });

  const allWindows: (AvailabilityWindow & { menuItemId: string | null })[] = windows.map((w) => ({
    menuItemId: w.menuItemId,
    daysOfWeek: w.daysOfWeek,
    startMinutes: w.startMinutes,
    endMinutes: w.endMinutes,
  }));
  const { publicationWindows, itemWindows } = partitionWindows(allWindows, menuItem.id);
  const availabilityExceptions: AvailabilityException[] = exceptions.map((e) => ({
    date: e.date,
    isClosed: e.isClosed,
  }));

  const available =
    (override ? override.isAvailable : true) &&
    isItemAvailableAt({
      timezone: publication.branch.timezone,
      at: input.at,
      publicationWindows,
      itemWindows,
      exceptions: availabilityExceptions,
    });
  if (!available) {
    throw new OrderPricingError(
      'The menu item is not available for this branch/channel at the current time.',
      'ITEM_UNAVAILABLE'
    );
  }

  // Winning price: item override > publication list > base (org-default) list.
  let unitPrice: Prisma.Decimal | null = null;
  let priceSource: PriceSource | null = null;
  if (override?.priceOverride != null) {
    unitPrice = override.priceOverride;
    priceSource = 'OVERRIDE';
  } else {
    const publicationList = publication.priceListId
      ? await resolveEffectiveEntries(db, publication.priceListId, input.at)
      : null;
    const pub = publicationList
      ? pickEntry(publicationList.entries, menuItem.productId, menuItem.variantId)
      : null;
    if (pub) {
      unitPrice = pub.price;
      priceSource = 'PUBLICATION_LIST';
    } else {
      const defaultList = await db.restaurantPriceList.findFirst({
        where: { isDefault: true },
        select: { id: true },
      });
      const baseList =
        defaultList && defaultList.id !== publication.priceListId
          ? await resolveEffectiveEntries(db, defaultList.id, input.at)
          : null;
      const base = baseList
        ? pickEntry(baseList.entries, menuItem.productId, menuItem.variantId)
        : null;
      if (base) {
        unitPrice = base.price;
        priceSource = 'BASE_LIST';
      }
    }
  }
  if (unitPrice == null || priceSource == null) {
    throw new OrderPricingError(
      'The menu item has no effective price for this order.',
      'ITEM_NOT_PRICED'
    );
  }

  const modifiers = await resolveModifierSnapshots(
    db,
    menuItem.productId,
    input.modifierOptionIds ?? []
  );

  return {
    productId: menuItem.productId,
    variantId: menuItem.variantId,
    name: menuItem.displayName ?? menuItem.product.name,
    unitPrice,
    priceSource,
    modifiers,
    taxAmount: ZERO,
    serviceChargeAmount: ZERO,
  };
}

/**
 * Snapshot the selected modifier options for a product. Each option must exist in
 * scope AND belong to a modifier group attached to the product (a POS may not
 * attach an arbitrary option to an item). The selection must contain unique
 * options and satisfy every attached group's min/max bounds. Preserves the
 * caller's selection order.
 */
export async function resolveModifierSnapshots(
  db: ScopedDb,
  productId: string,
  modifierOptionIds: readonly string[]
): Promise<ResolvedModifierSnapshot[]> {
  if (new Set(modifierOptionIds).size !== modifierOptionIds.length) {
    throw new OrderPricingError(
      'A modifier option cannot be selected more than once.',
      'MODIFIER_DUPLICATE'
    );
  }

  const options =
    modifierOptionIds.length === 0
      ? []
      : await db.restaurantModifierOption.findMany({
          where: { id: { in: [...modifierOptionIds] } },
          select: { id: true, name: true, priceDelta: true, modifierGroupId: true },
        });
  const byId = new Map(options.map((o) => [o.id, o]));

  const attachments = await db.restaurantProductModifierGroup.findMany({
    where: { productId },
    select: {
      modifierGroupId: true,
      modifierGroup: { select: { name: true, minSelect: true, maxSelect: true } },
    },
  });
  const attachedGroups = new Map(attachments.map((a) => [a.modifierGroupId, a.modifierGroup]));
  const selectionsByGroup = new Map<string, number>();

  const snapshots = modifierOptionIds.map((optionId) => {
    const option = byId.get(optionId);
    if (!option) {
      throw new OrderPricingError(
        `Modifier option ${optionId} does not exist.`,
        'MODIFIER_NOT_FOUND'
      );
    }
    if (!attachedGroups.has(option.modifierGroupId)) {
      throw new OrderPricingError(
        `Modifier option ${optionId} is not attached to the item’s product.`,
        'MODIFIER_NOT_ATTACHED'
      );
    }
    selectionsByGroup.set(
      option.modifierGroupId,
      (selectionsByGroup.get(option.modifierGroupId) ?? 0) + 1
    );
    return { modifierOptionId: option.id, name: option.name, priceDelta: option.priceDelta };
  });

  for (const [groupId, group] of attachedGroups) {
    const selected = selectionsByGroup.get(groupId) ?? 0;
    if (selected < group.minSelect || (group.maxSelect != null && selected > group.maxSelect)) {
      const maximum = group.maxSelect == null ? 'any number of' : `at most ${group.maxSelect}`;
      throw new OrderPricingError(
        `Modifier group ${group.name} requires at least ${group.minSelect} and ${maximum} selections; received ${selected}.`,
        'MODIFIER_SELECTION_COUNT'
      );
    }
  }

  return snapshots;
}
