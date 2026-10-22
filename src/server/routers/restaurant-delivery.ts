import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  DeliveryError,
  createDeliveryAddress,
  createDeliveryZone,
  deactivateDeliveryZone,
  deleteDeliveryAddress,
  listDeliveryAddresses,
  listDeliveryZones,
  reactivateDeliveryZone,
  setDefaultDeliveryAddress,
  updateDeliveryAddress,
  updateDeliveryZone,
} from '@/lib/restaurant/delivery';
import { listCustomers } from '@/lib/restaurant/customers';
import { requireRestaurantBranchScope } from '@/server/restaurant-branch-scope';
import { annotateAudit } from '../audit';
import { capabilityProcedure, publicProcedure, router } from '../trpc';

const id = z.string().trim().min(1).max(200);
const money = z
  .string()
  .trim()
  .regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const coordinate = z
  .string()
  .trim()
  .regex(/^-?\d{1,3}(?:\.\d{1,6})?$/);
const zoneValues = {
  name: z.string().trim().min(1).max(200),
  fixedFee: money,
  minimumSubtotal: money.optional(),
  promisedMinutes: z.number().int().min(0).max(10_080),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  areaPostalLabel: z.string().trim().max(500).nullable().optional(),
};
const addressValues = {
  label: z.string().trim().min(1).max(200),
  recipientName: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(50),
  addressLine1: z.string().trim().min(1).max(500),
  addressLine2: z.string().trim().max(500).nullable().optional(),
  locality: z.string().trim().min(1).max(200),
  administrativeArea: z.string().trim().max(200).nullable().optional(),
  postalCode: z.string().trim().max(50).nullable().optional(),
  countryCode: z.string().trim().length(2),
  latitude: coordinate.nullable().optional(),
  longitude: coordinate.nullable().optional(),
  isDefault: z.boolean().optional(),
};

const configureProcedure = capabilityProcedure('restaurant:configure');

function addressProcedure(action: Parameters<typeof capabilityProcedure>[0]) {
  return publicProcedure
    .use(({ ctx, next }) => {
      annotateAudit(ctx, { skipInput: true });
      return next();
    })
    .concat(capabilityProcedure(action));
}

const addressReadProcedure = addressProcedure('customers:read');
const addressManageProcedure = addressProcedure('customers:manage');

function mapDeliveryError(error: unknown): never {
  if (!(error instanceof DeliveryError)) throw error;
  const code =
    error.reason === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : error.reason === 'ALREADY_EXISTS'
        ? 'CONFLICT'
        : 'BAD_REQUEST';
  throw new TRPCError({ code, message: error.message, cause: error });
}

function serializeZone<
  T extends { fixedFee: { toString(): string }; minimumSubtotal: { toString(): string } },
>(zone: T) {
  return {
    ...zone,
    fixedFee: zone.fixedFee.toString(),
    minimumSubtotal: zone.minimumSubtotal.toString(),
  };
}

function serializeAddress<
  T extends {
    latitude: { toString(): string } | null;
    longitude: { toString(): string } | null;
  },
>(address: T) {
  return {
    ...address,
    latitude: address.latitude?.toString() ?? null,
    longitude: address.longitude?.toString() ?? null,
  };
}

export const restaurantDeliveryRouter = router({
  listCustomers: addressReadProcedure
    .input(
      z
        .object({
          query: z.string().trim().min(1).max(200).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: id.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const page = await listCustomers(ctx.db, input);
      return {
        customers: page.customers.map(({ id, displayName, givenName, familyName }) => ({
          id,
          displayName,
          givenName,
          familyName,
        })),
        nextCursor: page.nextCursor,
      };
    }),

  listZones: configureProcedure
    .input(z.object({ branchId: id }).strict())
    .query(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      try {
        const zones = await listDeliveryZones(
          ctx.db,
          ctx.entitlements.organizationId,
          input.branchId
        );
        return zones.map(serializeZone);
      } catch (error) {
        mapDeliveryError(error);
      }
    }),

  createZone: configureProcedure
    .input(z.object({ branchId: id, ...zoneValues }).strict())
    .mutation(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      try {
        const zone = await createDeliveryZone(ctx.db, {
          ...input,
          organizationId: ctx.entitlements.organizationId,
        });
        annotateAudit(ctx, { targetType: 'RestaurantDeliveryZone', targetId: zone.id });
        return serializeZone(zone);
      } catch (error) {
        mapDeliveryError(error);
      }
    }),

  updateZone: configureProcedure
    .input(z.object({ branchId: id, zoneId: id, ...zoneValues }).strict())
    .mutation(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      annotateAudit(ctx, { targetType: 'RestaurantDeliveryZone', targetId: input.zoneId });
      try {
        return serializeZone(
          await updateDeliveryZone(ctx.db, {
            ...input,
            organizationId: ctx.entitlements.organizationId,
          })
        );
      } catch (error) {
        mapDeliveryError(error);
      }
    }),

  deactivateZone: configureProcedure
    .input(z.object({ branchId: id, zoneId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      annotateAudit(ctx, { targetType: 'RestaurantDeliveryZone', targetId: input.zoneId });
      try {
        await deactivateDeliveryZone(ctx.db, {
          ...input,
          organizationId: ctx.entitlements.organizationId,
        });
      } catch (error) {
        mapDeliveryError(error);
      }
    }),

  reactivateZone: configureProcedure
    .input(z.object({ branchId: id, zoneId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      await requireRestaurantBranchScope(ctx, input.branchId);
      annotateAudit(ctx, { targetType: 'RestaurantDeliveryZone', targetId: input.zoneId });
      try {
        await reactivateDeliveryZone(ctx.db, {
          ...input,
          organizationId: ctx.entitlements.organizationId,
        });
      } catch (error) {
        mapDeliveryError(error);
      }
    }),

  listAddresses: addressReadProcedure
    .input(z.object({ customerId: id }).strict())
    .query(async ({ ctx, input }) => {
      try {
        const addresses = await listDeliveryAddresses(
          ctx.db,
          ctx.entitlements.organizationId,
          input.customerId
        );
        return addresses.map(serializeAddress);
      } catch (error) {
        mapDeliveryError(error);
      }
    }),

  createAddress: addressManageProcedure
    .input(z.object({ customerId: id, ...addressValues }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const address = await createDeliveryAddress(ctx.db, {
          ...input,
          organizationId: ctx.entitlements.organizationId,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantCustomerAddress',
          targetId: address.id,
          skipInput: true,
        });
        return serializeAddress(address);
      } catch (error) {
        mapDeliveryError(error);
      }
    }),

  updateAddress: addressManageProcedure
    .input(z.object({ customerId: id, addressId: id, ...addressValues }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        targetType: 'RestaurantCustomerAddress',
        targetId: input.addressId,
        skipInput: true,
      });
      try {
        return serializeAddress(
          await updateDeliveryAddress(ctx.db, {
            ...input,
            organizationId: ctx.entitlements.organizationId,
          })
        );
      } catch (error) {
        mapDeliveryError(error);
      }
    }),

  setDefaultAddress: addressManageProcedure
    .input(z.object({ customerId: id, addressId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        targetType: 'RestaurantCustomerAddress',
        targetId: input.addressId,
        skipInput: true,
      });
      try {
        return serializeAddress(
          await setDefaultDeliveryAddress(ctx.db, {
            ...input,
            organizationId: ctx.entitlements.organizationId,
          })
        );
      } catch (error) {
        mapDeliveryError(error);
      }
    }),

  deleteAddress: addressManageProcedure
    .input(z.object({ customerId: id, addressId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        targetType: 'RestaurantCustomerAddress',
        targetId: input.addressId,
        skipInput: true,
      });
      try {
        await deleteDeliveryAddress(ctx.db, {
          ...input,
          organizationId: ctx.entitlements.organizationId,
        });
      } catch (error) {
        mapDeliveryError(error);
      }
    }),
});
