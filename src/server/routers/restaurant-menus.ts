import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import type { Prisma } from '@/generated/prisma/client';
import type { Action } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { orderChannelSchema } from '@/lib/restaurant/order-channels';
import { assertInOrganization } from '../org-refs';
import { router, capabilityProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import {
  MenuError,
  createMenu,
  createMenuItem,
  createMenuSection,
  deleteMenu,
  deleteMenuItem,
  deleteMenuSection,
  updateMenu,
  updateMenuItem,
  updateMenuSection,
} from '@/lib/restaurant/menus';
import {
  PriceListError,
  activatePriceListVersion,
  addPriceListEntry,
  createPriceList,
  createPriceListVersion,
  normalizePrice,
  pickEntry,
  removePriceListEntry,
  resolveEffectiveEntries,
  supersedePriceListVersion,
  updatePriceListEntry,
  type ResolvedPriceList,
} from '@/lib/restaurant/price-lists';
import {
  channelPublished,
  isItemAvailableAt,
  partitionWindows,
  type AvailabilityException,
  type AvailabilityWindow,
  type OrderChannel,
} from '@/lib/restaurant/menu-availability';

/**
 * M3-L3 — the server surface for menus, price lists and branch-menu publications.
 *
 * Procedures are capability-gated through the ABAC engine (§8):
 * - `menu:write` authors the brand catalog's menu structure,
 * - `menu:price` manages price lists and per-publication price/availability overrides,
 * - `menu:publish` runs the publication lifecycle (publish/retire) and dayparts,
 * - `menu:read` serves the effective-menu read model.
 *
 * These four capabilities are granted to organization roles by the L1
 * `vertical-catalog` role templates (C7) and resolved through the ABAC
 * `customDecision` DB path exactly like `staff:manage` — a restaurant GM with
 * `menu:publish` is authorized without being a global platform ADMIN. They are not
 * yet members of the ABAC `ALL_ACTIONS` union (registering them there is an
 * abac-owned change outside this lane's file set — flagged to the supervisor), so
 * each capability string is asserted as an `Action` here; `can()` matches it by the
 * granted org-role capability at runtime and default-denies an ungranted subject.
 *
 * Money crosses the tRPC boundary as a STRING (C4): superjson does not carry a
 * Prisma `Decimal`, and catalog pricing must never round-trip through a float, so
 * every price in a response is serialized with `Decimal.toString()`.
 */

const MENU_READ = 'menu:read' as Action;
const MENU_WRITE = 'menu:write' as Action;
const MENU_PRICE = 'menu:price' as Action;
const MENU_PUBLISH = 'menu:publish' as Action;

const readProcedure = capabilityProcedure(MENU_READ);
const writeProcedure = capabilityProcedure(MENU_WRITE);
const priceProcedure = capabilityProcedure(MENU_PRICE);
const publishProcedure = capabilityProcedure(MENU_PUBLISH);

const LOCALIZED = z.record(z.string(), z.string());
// Money arrives as a string so it never passes through a float (C4); the lib
// normalizes it through `Prisma.Decimal` and rejects anything malformed.
const MONEY = z.string().min(1);
const MINUTE_OF_DAY = z.number().int().min(0).max(1440);
const DAY_OF_WEEK = z.number().int().min(0).max(6);

/** Translate a menu-domain error into the right tRPC status; rethrow anything else. */
function mapDomainError(err: unknown): never {
  if (err instanceof MenuError) {
    const code =
      err.reason === 'MENU_IN_USE'
        ? 'CONFLICT'
        : err.reason.endsWith('_NOT_FOUND')
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  if (err instanceof PriceListError) {
    const code =
      err.reason === 'ENTRY_EXISTS' || err.reason === 'DUPLICATE_EFFECTIVE_FROM'
        ? 'CONFLICT'
        : err.reason.endsWith('_NOT_FOUND')
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  // Version immutability / transition guards (L1 effective-dating primitives).
  if (
    err instanceof Error &&
    (err.name === 'VersionImmutabilityError' || err.name === 'VersionTransitionError')
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: err.message });
  }
  throw err;
}

async function run<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    mapDomainError(err);
  }
}

function serializePrice(price: Prisma.Decimal | null): string | null {
  return price == null ? null : price.toString();
}

// A publication error surface distinct from the menu/price-list domain errors.
type PublicationErrorReason =
  | 'PUBLICATION_NOT_FOUND'
  | 'BRANCH_NOT_FOUND'
  | 'MENU_NOT_FOUND'
  | 'PRICE_LIST_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'INVALID_STATE';

function publicationError(reason: PublicationErrorReason, message: string): never {
  const code =
    reason === 'INVALID_STATE'
      ? 'CONFLICT'
      : reason.endsWith('_NOT_FOUND')
        ? 'NOT_FOUND'
        : 'BAD_REQUEST';
  throw new TRPCError({ code, message });
}

export const restaurantMenusRouter = router({
  // ── Console read models (menu:read) ────────────────────────────────────────
  listMenus: readProcedure.query(({ ctx }) =>
    ctx.db.restaurantMenu.findMany({
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      include: {
        brand: true,
        _count: { select: { sections: true, publications: true } },
      },
    })
  ),

  getMenu: readProcedure
    .input(z.object({ id: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const menu = await ctx.db.restaurantMenu.findUnique({
        where: { id: input.id },
        include: {
          brand: true,
          sections: {
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            include: {
              items: {
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
                include: { product: true, variant: true },
              },
            },
          },
        },
      });
      if (!menu) publicationError('MENU_NOT_FOUND', 'The menu does not exist.');
      return menu;
    }),

  listPriceLists: readProcedure.query(({ ctx }) =>
    ctx.db.restaurantPriceList.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { versions: true, publications: true } } },
    })
  ),

  getPriceList: readProcedure
    .input(z.object({ id: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const priceList = await ctx.db.restaurantPriceList.findUnique({
        where: { id: input.id },
        include: {
          versions: {
            orderBy: { versionNumber: 'desc' },
            include: {
              entries: {
                orderBy: { createdAt: 'asc' },
                include: { product: true, variant: true },
              },
            },
          },
        },
      });
      if (!priceList) publicationError('PRICE_LIST_NOT_FOUND', 'The price list does not exist.');
      return {
        ...priceList,
        versions: priceList.versions.map((version) => ({
          ...version,
          entries: version.entries.map((entry) => ({
            ...entry,
            price: entry.price.toString(),
          })),
        })),
      };
    }),

  listPublications: readProcedure.query(({ ctx }) =>
    ctx.db.restaurantBranchMenuPublication.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        branch: true,
        menu: true,
        priceList: true,
        _count: { select: { windows: true, exceptions: true, itemOverrides: true } },
      },
    })
  ),

  getPublication: readProcedure
    .input(z.object({ id: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const publication = await ctx.db.restaurantBranchMenuPublication.findUnique({
        where: { id: input.id },
        include: {
          branch: true,
          menu: {
            include: {
              sections: {
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
                include: {
                  items: {
                    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
                    include: { product: true, variant: true },
                  },
                },
              },
            },
          },
          priceList: true,
          windows: {
            orderBy: { createdAt: 'asc' },
            include: { menuItem: { include: { product: true, variant: true } } },
          },
          exceptions: { orderBy: { date: 'asc' } },
          itemOverrides: {
            orderBy: { createdAt: 'asc' },
            include: { menuItem: { include: { product: true, variant: true } } },
          },
        },
      });
      if (!publication) {
        publicationError('PUBLICATION_NOT_FOUND', 'The publication does not exist.');
      }
      return {
        ...publication,
        itemOverrides: publication.itemOverrides.map((override) => ({
          ...override,
          priceOverride: serializePrice(override.priceOverride),
        })),
      };
    }),

  listAvailabilityWindows: readProcedure
    .input(z.object({ publicationId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      await loadPublication(ctx.db, input.publicationId);
      return ctx.db.restaurantMenuAvailabilityWindow.findMany({
        where: { publicationId: input.publicationId },
        orderBy: { createdAt: 'asc' },
        include: { menuItem: { include: { product: true, variant: true } } },
      });
    }),

  listAvailabilityExceptions: readProcedure
    .input(z.object({ publicationId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      await loadPublication(ctx.db, input.publicationId);
      return ctx.db.restaurantMenuAvailabilityException.findMany({
        where: { publicationId: input.publicationId },
        orderBy: { date: 'asc' },
      });
    }),

  listItemOverrides: readProcedure
    .input(z.object({ publicationId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      await loadPublication(ctx.db, input.publicationId);
      const overrides = await ctx.db.restaurantBranchMenuItemOverride.findMany({
        where: { publicationId: input.publicationId },
        orderBy: { createdAt: 'asc' },
        include: { menuItem: { include: { product: true, variant: true } } },
      });
      return overrides.map((override) => ({
        ...override,
        priceOverride: serializePrice(override.priceOverride),
      }));
    }),

  // ── Menu authoring (menu:write) ─────────────────────────────────────────────
  createMenu: writeProcedure
    .input(
      z.object({
        brandId: z.string().min(1),
        name: z.string().min(1).max(200),
        nameLocalized: LOCALIZED.nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const menu = await run(() => createMenu(ctx.db, input));
      annotateAudit(ctx, {
        targetType: 'RestaurantMenu',
        targetId: menu.id,
        targetLabel: menu.name,
        description: `Created menu "${menu.name}"`,
        metadata: { brandId: menu.brandId },
      });
      return menu;
    }),

  updateMenu: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        nameLocalized: LOCALIZED.nullable().optional(),
        description: z.string().max(2000).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const menu = await run(() => updateMenu(ctx.db, id, patch));
      annotateAudit(ctx, {
        targetType: 'RestaurantMenu',
        targetId: menu.id,
        targetLabel: menu.name,
        description: `Updated menu "${menu.name}"`,
      });
      return menu;
    }),

  deleteMenu: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await run(() => deleteMenu(ctx.db, input.id));
      annotateAudit(ctx, {
        targetType: 'RestaurantMenu',
        targetId: input.id,
        description: 'Deleted menu',
      });
      return result;
    }),

  createSection: writeProcedure
    .input(
      z.object({
        menuId: z.string().min(1),
        name: z.string().min(1).max(200),
        nameLocalized: LOCALIZED.nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const section = await run(() => createMenuSection(ctx.db, input));
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuSection',
        targetId: section.id,
        targetLabel: section.name,
        description: `Created menu section "${section.name}"`,
        metadata: { menuId: section.menuId },
      });
      return section;
    }),

  updateSection: writeProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        nameLocalized: LOCALIZED.nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const section = await run(() => updateMenuSection(ctx.db, id, patch));
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuSection',
        targetId: section.id,
        description: 'Updated menu section',
      });
      return section;
    }),

  deleteSection: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await run(() => deleteMenuSection(ctx.db, input.id));
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuSection',
        targetId: input.id,
        description: 'Deleted menu section',
      });
      return result;
    }),

  createItem: writeProcedure
    .input(
      z.object({
        sectionId: z.string().min(1),
        productId: z.string().min(1),
        variantId: z.string().nullable().optional(),
        displayName: z.string().max(200).nullable().optional(),
        nameLocalized: LOCALIZED.nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const item = await run(() => createMenuItem(ctx.db, input));
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuItem',
        targetId: item.id,
        description: 'Added menu item',
        metadata: { sectionId: item.sectionId, productId: item.productId },
      });
      return item;
    }),

  updateItem: writeProcedure
    .input(
      z.object({
        id: z.string(),
        displayName: z.string().max(200).nullable().optional(),
        nameLocalized: LOCALIZED.nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      const item = await run(() => updateMenuItem(ctx.db, id, patch));
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuItem',
        targetId: item.id,
        description: 'Updated menu item',
      });
      return item;
    }),

  deleteItem: writeProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await run(() => deleteMenuItem(ctx.db, input.id));
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuItem',
        targetId: input.id,
        description: 'Removed menu item',
      });
      return result;
    }),

  // ── Price lists & effective-dated versions (menu:price) ─────────────────────
  createPriceList: priceProcedure
    .input(z.object({ name: z.string().min(1).max(200), isDefault: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const list = await run(() => createPriceList(ctx.db, input));
      annotateAudit(ctx, {
        targetType: 'RestaurantPriceList',
        targetId: list.id,
        targetLabel: list.name,
        description: `Created price list "${list.name}"`,
        metadata: { isDefault: list.isDefault },
      });
      return list;
    }),

  createPriceListVersion: priceProcedure
    .input(z.object({ priceListId: z.string().min(1), effectiveFrom: z.date() }))
    .mutation(async ({ ctx, input }) => {
      const version = await run(() => createPriceListVersion(ctx.db, input));
      annotateAudit(ctx, {
        targetType: 'RestaurantPriceListVersion',
        targetId: version.id,
        description: 'Opened a draft price-list version',
        metadata: { priceListId: version.priceListId, versionNumber: version.versionNumber },
      });
      return version;
    }),

  activatePriceListVersion: priceProcedure
    .input(z.object({ versionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      // Server supplies the activation instant; client time is untrusted (C5).
      const version = await run(() =>
        activatePriceListVersion(ctx.db, input.versionId, new Date())
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantPriceListVersion',
        targetId: version.id,
        description: 'Activated a price-list version',
      });
      return version;
    }),

  supersedePriceListVersion: priceProcedure
    .input(z.object({ versionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const version = await run(() =>
        supersedePriceListVersion(ctx.db, input.versionId, new Date())
      );
      annotateAudit(ctx, {
        targetType: 'RestaurantPriceListVersion',
        targetId: version.id,
        description: 'Superseded a price-list version',
      });
      return version;
    }),

  addPriceEntry: priceProcedure
    .input(
      z.object({
        priceListVersionId: z.string().min(1),
        productId: z.string().min(1),
        variantId: z.string().nullable().optional(),
        price: MONEY,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const entry = await run(() => addPriceListEntry(ctx.db, input));
      annotateAudit(ctx, {
        targetType: 'RestaurantPriceListEntry',
        targetId: entry.id,
        description: 'Added a price-list entry',
        metadata: { productId: entry.productId, variantId: entry.variantId },
      });
      return { ...entry, price: entry.price.toString() };
    }),

  updatePriceEntry: priceProcedure
    .input(z.object({ entryId: z.string().min(1), price: MONEY }))
    .mutation(async ({ ctx, input }) => {
      const entry = await run(() => updatePriceListEntry(ctx.db, input.entryId, input.price));
      annotateAudit(ctx, {
        targetType: 'RestaurantPriceListEntry',
        targetId: entry.id,
        description: 'Updated a price-list entry',
      });
      return { ...entry, price: entry.price.toString() };
    }),

  removePriceEntry: priceProcedure
    .input(z.object({ entryId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result = await run(() => removePriceListEntry(ctx.db, input.entryId));
      annotateAudit(ctx, {
        targetType: 'RestaurantPriceListEntry',
        targetId: input.entryId,
        description: 'Removed a price-list entry',
      });
      return result;
    }),

  // ── Branch-menu publications (menu:publish) ─────────────────────────────────
  createPublication: publishProcedure
    .input(
      z.object({
        branchId: z.string().min(1),
        menuId: z.string().min(1),
        priceListId: z.string().nullable().optional(),
        channels: z.array(orderChannelSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Client branch, menu, and price-list ids are checked against the session
      // organization. A foreign key does not apply row level security, and an
      // inactive branch cannot receive a publication.
      const organizationId = ctx.entitlements.organizationId;
      if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      await assertInOrganization(ctx.db.restaurantBranch, organizationId, [input.branchId], {
        active: true,
      });
      await assertInOrganization(ctx.db.restaurantMenu, organizationId, [input.menuId]);
      if (input.priceListId) {
        await assertInOrganization(ctx.db.restaurantPriceList, organizationId, [input.priceListId]);
      }

      const publication = await ctx.db.restaurantBranchMenuPublication.create({
        data: {
          branchId: input.branchId,
          menuId: input.menuId,
          priceListId: input.priceListId ?? null,
          channels: input.channels ?? [],
          status: 'DRAFT',
        },
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantBranchMenuPublication',
        targetId: publication.id,
        description: 'Created a draft branch-menu publication',
        metadata: { branchId: publication.branchId, menuId: publication.menuId },
      });
      return publication;
    }),

  publishPublication: publishProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const publication = await loadPublication(ctx.db, input.id);
      if (publication.status === 'PUBLISHED') {
        publicationError('INVALID_STATE', 'The publication is already published.');
      }
      const updated = await ctx.db.restaurantBranchMenuPublication.update({
        where: { id: input.id },
        data: { status: 'PUBLISHED', publishedAt: new Date(), retiredAt: null },
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantBranchMenuPublication',
        targetId: updated.id,
        description: 'Published a branch-menu publication',
        metadata: { branchId: updated.branchId, menuId: updated.menuId },
      });
      return updated;
    }),

  retirePublication: publishProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const publication = await loadPublication(ctx.db, input.id);
      if (publication.status !== 'PUBLISHED') {
        publicationError('INVALID_STATE', 'Only a published publication can be retired.');
      }
      const updated = await ctx.db.restaurantBranchMenuPublication.update({
        where: { id: input.id },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantBranchMenuPublication',
        targetId: updated.id,
        description: 'Retired a branch-menu publication',
      });
      return updated;
    }),

  setPublicationChannels: publishProcedure
    .input(z.object({ id: z.string().min(1), channels: z.array(orderChannelSchema) }))
    .mutation(async ({ ctx, input }) => {
      await loadPublication(ctx.db, input.id);
      const updated = await ctx.db.restaurantBranchMenuPublication.update({
        where: { id: input.id },
        data: { channels: input.channels },
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantBranchMenuPublication',
        targetId: updated.id,
        description: 'Updated publication channels',
        metadata: { channels: input.channels },
      });
      return updated;
    }),

  addAvailabilityWindow: publishProcedure
    .input(
      z.object({
        publicationId: z.string().min(1),
        menuItemId: z.string().nullable().optional(),
        label: z.string().max(120).nullable().optional(),
        daysOfWeek: z.array(DAY_OF_WEEK).max(7),
        startMinutes: MINUTE_OF_DAY,
        endMinutes: MINUTE_OF_DAY,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const publication = await loadPublication(ctx.db, input.publicationId);
      if (input.menuItemId) await assertItemOnMenu(ctx.db, publication.menuId, input.menuItemId);
      const window = await ctx.db.restaurantMenuAvailabilityWindow.create({
        data: {
          publicationId: input.publicationId,
          menuItemId: input.menuItemId ?? null,
          label: input.label ?? null,
          daysOfWeek: input.daysOfWeek,
          startMinutes: input.startMinutes,
          endMinutes: input.endMinutes,
        },
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuAvailabilityWindow',
        targetId: window.id,
        description: 'Added an availability window',
        metadata: { publicationId: input.publicationId, menuItemId: input.menuItemId ?? null },
      });
      return window;
    }),

  removeAvailabilityWindow: publishProcedure
    .input(z.object({ windowId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.restaurantMenuAvailabilityWindow.findUnique({
        where: { id: input.windowId },
        select: { id: true },
      });
      if (!existing)
        publicationError('PUBLICATION_NOT_FOUND', 'The availability window does not exist.');
      await ctx.db.restaurantMenuAvailabilityWindow.delete({ where: { id: input.windowId } });
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuAvailabilityWindow',
        targetId: input.windowId,
        description: 'Removed an availability window',
      });
      return { id: input.windowId };
    }),

  setAvailabilityException: publishProcedure
    .input(
      z.object({
        publicationId: z.string().min(1),
        date: z.date(),
        isClosed: z.boolean(),
        label: z.string().max(120).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await loadPublication(ctx.db, input.publicationId);
      // One exception per (publication, date): upsert on the unique key.
      const exception = await ctx.db.restaurantMenuAvailabilityException.upsert({
        where: {
          publicationId_date: { publicationId: input.publicationId, date: input.date },
        },
        create: {
          publicationId: input.publicationId,
          date: input.date,
          isClosed: input.isClosed,
          label: input.label ?? null,
        },
        update: { isClosed: input.isClosed, label: input.label ?? null },
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuAvailabilityException',
        targetId: exception.id,
        description: 'Set an availability exception',
        metadata: { publicationId: input.publicationId, isClosed: input.isClosed },
      });
      return exception;
    }),

  removeAvailabilityException: publishProcedure
    .input(z.object({ exceptionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.restaurantMenuAvailabilityException.findUnique({
        where: { id: input.exceptionId },
        select: { id: true },
      });
      if (!existing)
        publicationError('PUBLICATION_NOT_FOUND', 'The availability exception does not exist.');
      await ctx.db.restaurantMenuAvailabilityException.delete({ where: { id: input.exceptionId } });
      annotateAudit(ctx, {
        targetType: 'RestaurantMenuAvailabilityException',
        targetId: input.exceptionId,
        description: 'Removed an availability exception',
      });
      return { id: input.exceptionId };
    }),

  // ── Per-publication item overrides (menu:price) ─────────────────────────────
  // C2: an override carries ONLY availability + an optional price — never content.
  // BUILD-ASSUMPTIONS: a price override is gated by `menu:price` alone (no co-auth).
  setItemOverride: priceProcedure
    .input(
      z
        .object({
          publicationId: z.string().min(1),
          menuItemId: z.string().min(1),
          isAvailable: z.boolean().optional(),
          priceOverride: MONEY.nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const publication = await loadPublication(ctx.db, input.publicationId);
      await assertItemOnMenu(ctx.db, publication.menuId, input.menuItemId);
      // A price override obeys the same C4 decimal rules as a price-list entry;
      // `normalizePrice` throws PriceListError (mapped to 400) on a malformed value.
      const price = await run(async () =>
        input.priceOverride == null ? null : normalizePrice(input.priceOverride).toString()
      );
      const isAvailable = input.isAvailable ?? true;
      const override = await ctx.db.restaurantBranchMenuItemOverride.upsert({
        where: {
          publicationId_menuItemId: {
            publicationId: input.publicationId,
            menuItemId: input.menuItemId,
          },
        },
        create: {
          publicationId: input.publicationId,
          menuItemId: input.menuItemId,
          isAvailable,
          priceOverride: price,
        },
        update: { isAvailable, priceOverride: price },
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantBranchMenuItemOverride',
        targetId: override.id,
        description: 'Set a branch menu-item override',
        metadata: {
          publicationId: input.publicationId,
          menuItemId: input.menuItemId,
          isAvailable,
          hasPriceOverride: price != null,
        },
      });
      return { ...override, priceOverride: serializePrice(override.priceOverride) };
    }),

  clearItemOverride: priceProcedure
    .input(z.object({ overrideId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.restaurantBranchMenuItemOverride.findUnique({
        where: { id: input.overrideId },
        select: { id: true },
      });
      if (!existing) publicationError('ITEM_NOT_FOUND', 'The override does not exist.');
      await ctx.db.restaurantBranchMenuItemOverride.delete({ where: { id: input.overrideId } });
      annotateAudit(ctx, {
        targetType: 'RestaurantBranchMenuItemOverride',
        targetId: input.overrideId,
        description: 'Cleared a branch menu-item override',
      });
      return { id: input.overrideId };
    }),

  // ── Effective-menu read model (menu:read) — the §12.3 POS-cacheable seam ─────
  effectiveMenu: readProcedure
    .input(
      z.object({
        publicationId: z.string().min(1),
        channel: orderChannelSchema,
        // Optional evaluation instant (preview / historical). Absent = server now;
        // client time is never trusted for availability, only for an explicit query.
        at: z.date().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      return buildEffectiveMenu(ctx.db, input.publicationId, input.channel, input.at ?? new Date());
    }),
});

// ── Router-local publication helpers ──────────────────────────────────────────

/** Load a publication scoped to the caller's org, or throw NOT_FOUND (RLS scopes it). */
async function loadPublication(db: ScopedDb, id: string) {
  const publication = await db.restaurantBranchMenuPublication.findUnique({
    where: { id },
    select: { id: true, status: true, branchId: true, menuId: true, channels: true },
  });
  if (!publication) {
    publicationError('PUBLICATION_NOT_FOUND', 'The publication does not exist.');
  }
  return publication;
}

/** A window/override may only target a menu item that belongs to the published menu. */
async function assertItemOnMenu(db: ScopedDb, menuId: string, menuItemId: string) {
  const item = await db.restaurantMenuItem.findUnique({
    where: { id: menuItemId },
    select: { section: { select: { menuId: true } } },
  });
  if (!item || item.section.menuId !== menuId) {
    publicationError('ITEM_NOT_FOUND', 'The menu item does not belong to the published menu.');
  }
}

export type EffectiveMenuItem = {
  id: string;
  productId: string;
  variantId: string | null;
  displayName: string | null;
  nameLocalized: Prisma.JsonValue | null;
  sortOrder: number;
  product: {
    id: string;
    name: string;
    type: string;
    status: string;
    nameLocalized: Prisma.JsonValue | null;
    descriptionLocalized: Prisma.JsonValue | null;
  };
  variant: { id: string; name: string; nameLocalized: Prisma.JsonValue | null } | null;
  modifierGroups: Array<{
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number | null;
    options: Array<{ id: string; name: string; priceDelta: string }>;
  }>;
  /** Winning price (item override > publication list > base list), as a C4 string. */
  price: string | null;
  priceSource: 'OVERRIDE' | 'PUBLICATION_LIST' | 'BASE_LIST' | 'NONE';
  available: boolean;
};

export async function buildEffectiveMenu(
  db: ScopedDb,
  publicationId: string,
  channel: OrderChannel,
  at: Date
) {
  const publication = await db.restaurantBranchMenuPublication.findUnique({
    where: { id: publicationId },
    include: {
      branch: { select: { id: true, name: true, timezone: true } },
      windows: {
        select: { menuItemId: true, daysOfWeek: true, startMinutes: true, endMinutes: true },
      },
      exceptions: { select: { date: true, isClosed: true } },
      itemOverrides: {
        select: { menuItemId: true, isAvailable: true, priceOverride: true },
      },
      menu: {
        select: {
          id: true,
          name: true,
          nameLocalized: true,
          description: true,
          sections: {
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            select: {
              id: true,
              name: true,
              nameLocalized: true,
              sortOrder: true,
              items: {
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
                select: {
                  id: true,
                  productId: true,
                  variantId: true,
                  displayName: true,
                  nameLocalized: true,
                  sortOrder: true,
                  product: {
                    select: {
                      id: true,
                      name: true,
                      type: true,
                      status: true,
                      nameLocalized: true,
                      descriptionLocalized: true,
                      modifierGroups: {
                        orderBy: { sortOrder: 'asc' },
                        select: {
                          modifierGroup: {
                            select: {
                              id: true,
                              name: true,
                              minSelect: true,
                              maxSelect: true,
                              options: {
                                orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                                select: { id: true, name: true, priceDelta: true },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  variant: { select: { id: true, name: true, nameLocalized: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!publication) {
    publicationError('PUBLICATION_NOT_FOUND', 'The publication does not exist.');
  }

  const channelOpen = channelPublished(publication.channels as OrderChannel[], channel);

  // Resolve the winning price lists once at instant T (avoids an N+1 per item).
  const publicationList: ResolvedPriceList | null = publication.priceListId
    ? await resolveEffectiveEntries(db, publication.priceListId, at)
    : null;
  const defaultList = await db.restaurantPriceList.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  // The base (fallback) list is the org default; when it IS the publication's own
  // list, reuse the already-resolved entries instead of querying twice.
  let baseList: ResolvedPriceList | null = null;
  if (defaultList) {
    baseList =
      defaultList.id === publication.priceListId
        ? publicationList
        : await resolveEffectiveEntries(db, defaultList.id, at);
  }

  const overrideByItem = new Map(publication.itemOverrides.map((o) => [o.menuItemId, o]));
  const allWindows: (AvailabilityWindow & { menuItemId: string | null })[] =
    publication.windows.map((w) => ({
      menuItemId: w.menuItemId,
      daysOfWeek: w.daysOfWeek,
      startMinutes: w.startMinutes,
      endMinutes: w.endMinutes,
    }));
  const exceptions: AvailabilityException[] = publication.exceptions.map((e) => ({
    date: e.date,
    isClosed: e.isClosed,
  }));

  const sections = publication.menu.sections.map((section) => ({
    id: section.id,
    name: section.name,
    nameLocalized: section.nameLocalized,
    sortOrder: section.sortOrder,
    items: section.items.map((item): EffectiveMenuItem => {
      const override = overrideByItem.get(item.id) ?? null;
      const { publicationWindows, itemWindows } = partitionWindows(allWindows, item.id);

      // Winning price: item override > publication price list > base (default) list.
      let price: string | null = null;
      let priceSource: EffectiveMenuItem['priceSource'] = 'NONE';
      if (override?.priceOverride != null) {
        price = override.priceOverride.toString();
        priceSource = 'OVERRIDE';
      } else {
        const pub = publicationList
          ? pickEntry(publicationList.entries, item.productId, item.variantId)
          : null;
        if (pub) {
          price = pub.price.toString();
          priceSource = 'PUBLICATION_LIST';
        } else {
          const base = baseList
            ? pickEntry(baseList.entries, item.productId, item.variantId)
            : null;
          if (base) {
            price = base.price.toString();
            priceSource = 'BASE_LIST';
          }
        }
      }

      const overrideAvailable = override ? override.isAvailable : true;
      const available =
        channelOpen &&
        overrideAvailable &&
        isItemAvailableAt({
          timezone: publication.branch.timezone,
          at,
          publicationWindows,
          itemWindows,
          exceptions,
        });
      const { modifierGroups, ...product } = item.product;

      return {
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        displayName: item.displayName,
        nameLocalized: item.nameLocalized,
        sortOrder: item.sortOrder,
        product,
        modifierGroups: (modifierGroups ?? []).map(({ modifierGroup }) => ({
          ...modifierGroup,
          options: modifierGroup.options.map((option) => ({
            ...option,
            priceDelta: option.priceDelta.toString(),
          })),
        })),
        variant: item.variant,
        price,
        priceSource,
        available,
      };
    }),
  }));

  return {
    publication: {
      id: publication.id,
      status: publication.status,
      branch: publication.branch,
      channels: publication.channels,
      channel,
      channelPublished: channelOpen,
      priceListId: publication.priceListId,
      evaluatedAt: at,
    },
    menu: {
      id: publication.menu.id,
      name: publication.menu.name,
      nameLocalized: publication.menu.nameLocalized,
      description: publication.menu.description,
    },
    sections,
  };
}
