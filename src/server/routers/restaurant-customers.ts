import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  CustomerError,
  appendCustomerConsent,
  appendCustomerInteraction,
  assignCustomerTag,
  attachCustomerToOrder,
  correctCustomer,
  createCustomer,
  createCustomerTag,
  getCustomer,
  listCustomerTags,
  listCustomers,
  unassignCustomerTag,
} from '@/lib/restaurant/customers';
import { anonymizeCustomer, exportCustomerData } from '@/lib/restaurant/customer-privacy';
import { annotateAudit } from '../audit';
import { capabilityProcedure, router } from '../trpc';

const id = z.string().trim().min(1).max(200);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const identifier = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('EMAIL'),
      value: z.email().max(320).transform((value) => value.toLowerCase()),
      verifiedAt: z.date().nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('PHONE'),
      value: phone,
      verifiedAt: z.date().nullable().optional(),
    })
    .strict(),
]);
const identifierCorrection = z.discriminatedUnion('kind', [
  z
    .object({
      id: id.optional(),
      kind: z.literal('EMAIL'),
      value: z.email().max(320).transform((value) => value.toLowerCase()),
      verifiedAt: z.date().nullable().optional(),
    })
    .strict(),
  z
    .object({
      id: id.optional(),
      kind: z.literal('PHONE'),
      value: phone,
      verifiedAt: z.date().nullable().optional(),
    })
    .strict(),
]);
const profile = {
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  givenName: z.string().trim().min(1).max(100).nullable().optional(),
  familyName: z.string().trim().min(1).max(100).nullable().optional(),
  birthDate: z.date().nullable().optional(),
  notes: z.string().max(5_000).nullable().optional(),
};
const pair = z.object({ customerId: id, tagId: id }).strict();
const readProcedure = capabilityProcedure('customers:read');
const configureProcedure = capabilityProcedure('restaurant:configure');

function mapCustomerError(error: unknown): never {
  if (!(error instanceof CustomerError)) throw error;
  const code =
    error.reason === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : error.reason === 'INVALID_IDENTIFIER'
        ? 'BAD_REQUEST'
        : 'CONFLICT';
  throw new TRPCError({ code, message: error.message, cause: error });
}

export const restaurantCustomersRouter = router({
  list: readProcedure
    .input(
      z
        .object({
          query: z.string().trim().min(1).max(200).optional(),
          tagId: id.optional(),
          tagIds: z.array(id).max(50).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: id.optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listCustomers(ctx.db, input);
      } catch (error) {
        mapCustomerError(error);
      }
    }),

  detail: readProcedure
    .input(z.object({ customerId: id }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return await getCustomer(ctx.db, input.customerId);
      } catch (error) {
        mapCustomerError(error);
      }
    }),

  create: readProcedure
    .input(z.object({ ...profile, identifiers: z.array(identifier).max(20).optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await createCustomer(ctx.db, input);
      } catch (error) {
        mapCustomerError(error);
      }
    }),

  correct: readProcedure
    .input(
      z
        .object({
          customerId: id,
          ...profile,
          identifiers: z.array(identifierCorrection).max(20).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await correctCustomer(ctx.db, input);
      } catch (error) {
        mapCustomerError(error);
      }
    }),

  attachToOrder: readProcedure
    .input(z.object({ customerId: id, orderId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await attachCustomerToOrder(ctx.db, input);
      } catch (error) {
        mapCustomerError(error);
      }
    }),

  appendInteraction: readProcedure
    .input(
      z
        .object({
          customerId: id,
          branchId: id,
          orderId: id.nullable().optional(),
          type: z.string().trim().min(1).max(100),
          payload: z.record(z.string().min(1).max(100), z.json()).optional(),
          occurredAt: z.date().optional(),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await appendCustomerInteraction(ctx.db, input);
      } catch (error) {
        mapCustomerError(error);
      }
    }),

  appendConsent: readProcedure
    .input(
      z
        .object({
          customerId: id,
          channel: z.enum(['EMAIL', 'SMS', 'PHONE', 'WHATSAPP', 'PUSH']),
          granted: z.boolean(),
          source: z.string().trim().min(1).max(100),
          actorId: id,
          policyVersion: z.string().trim().min(1).max(100),
          occurredAt: z.date().optional(),
          idempotencyKey: z.string().trim().min(1).max(200),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await appendCustomerConsent(ctx.db, input);
      } catch (error) {
        mapCustomerError(error);
      }
    }),

  createTag: readProcedure
    .input(
      z
        .object({
          name: z.string().trim().min(1).max(100),
          color: z.string().trim().min(1).max(32).nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createCustomerTag(ctx.db, input);
      } catch (error) {
        mapCustomerError(error);
      }
    }),

  listTags: readProcedure.input(z.object({}).strict()).query(async ({ ctx }) => {
    try {
      return await listCustomerTags(ctx.db);
    } catch (error) {
      mapCustomerError(error);
    }
  }),

  assignTag: readProcedure.input(pair).mutation(async ({ ctx, input }) => {
    try {
      return await assignCustomerTag(ctx.db, input);
    } catch (error) {
      mapCustomerError(error);
    }
  }),

  unassignTag: readProcedure.input(pair).mutation(async ({ ctx, input }) => {
    try {
      return await unassignCustomerTag(ctx.db, input);
    } catch (error) {
      mapCustomerError(error);
    }
  }),

  export: readProcedure
    .input(z.object({ customerId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        action: 'restaurantCustomers.export',
        targetType: 'RestaurantCustomer',
        targetId: input.customerId,
        skipInput: true,
      });
      try {
        return await exportCustomerData(ctx.db, input.customerId);
      } catch (error) {
        mapCustomerError(error);
      }
    }),

  anonymize: configureProcedure
    .input(z.object({ customerId: id, at: z.date().optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, {
        action: 'restaurantCustomers.anonymize',
        targetType: 'RestaurantCustomer',
        targetId: input.customerId,
        skipInput: true,
      });
      try {
        return await anonymizeCustomer(ctx.db, input);
      } catch (error) {
        mapCustomerError(error);
      }
    }),
});
