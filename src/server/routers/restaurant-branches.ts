import { Prisma } from '@/generated/prisma/client';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { annotateAudit } from '../audit';
import { capabilityProcedure, router } from '../trpc';

const branchProcedure = capabilityProcedure('restaurant:configure');
const code = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/, 'Use letters, numbers, and single hyphens.');
const fields = z.object({
  name: z.string().trim().min(2).max(120),
  code,
  timezone: z.string().trim().min(1).max(80),
  businessDayCutoff: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  address: z.string().trim().max(300).nullable(),
  shiftSignInEnforced: z.boolean(),
});

function organizationId(ctx: { session: { user?: { organizationId?: string } } | null }) {
  const value = ctx.session?.user?.organizationId;
  if (!value) throw new TRPCError({ code: 'FORBIDDEN', message: 'Workspace access is required.' });
  return value;
}

function mapWriteError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'A branch with this name or code already exists.',
    });
  }
  throw error;
}

export const restaurantBranchesRouter = router({
  list: branchProcedure.query(async ({ ctx }) => {
    const organization = organizationId(ctx);
    const [branches, limit] = await Promise.all([
      ctx.db.restaurantBranch.findMany({
        where: { organizationId: organization },
        select: {
          id: true,
          name: true,
          code: true,
          timezone: true,
          businessDayCutoff: true,
          address: true,
          active: true,
          isDefault: true,
          shiftSignInEnforced: true,
        },
        orderBy: [{ isDefault: 'desc' }, { active: 'desc' }, { name: 'asc' }],
      }),
      Promise.resolve(
        (ctx.entitlements.limits as Record<string, number>)['restaurant.locations.max'] ?? 1
      ),
    ]);
    return { branches, limit };
  }),

  create: branchProcedure.input(fields).mutation(async ({ ctx, input }) => {
    const organization = organizationId(ctx);
    const limit =
      (ctx.entitlements.limits as Record<string, number>)['restaurant.locations.max'] ?? 1;
    try {
      const branch = await ctx.db.$transaction(async (tx) => {
        const count = await tx.restaurantBranch.count({ where: { organizationId: organization } });
        if (count >= limit) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Your plan supports ${limit} configured branch${limit === 1 ? '' : 'es'}.`,
          });
        }
        const duplicate = await tx.restaurantBranch.findFirst({
          where: {
            organizationId: organization,
            OR: [
              { name: { equals: input.name, mode: 'insensitive' } },
              { code: input.code.toUpperCase() },
            ],
          },
          select: { id: true },
        });
        if (duplicate) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A branch with this name or code already exists.',
          });
        }
        return tx.restaurantBranch.create({
          data: {
            ...input,
            code: input.code.toUpperCase(),
            organizationId: organization,
            active: true,
            isDefault: count === 0,
          },
        });
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantBranch',
        targetId: branch.id,
        targetLabel: `${branch.name} (${branch.code})`,
        description: `Created restaurant branch ${branch.code}`,
      });
      return branch;
    } catch (error) {
      mapWriteError(error);
    }
  }),

  update: branchProcedure
    .input(fields.partial().extend({ id: z.string(), isDefault: z.literal(true).optional() }))
    .mutation(async ({ ctx, input }) => {
      const organization = organizationId(ctx);
      const { id, isDefault, code: nextCode, ...patch } = input;
      try {
        const branch = await ctx.db.$transaction(async (tx) => {
          const current = await tx.restaurantBranch.findFirst({
            where: { id, organizationId: organization },
          });
          if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
          if (patch.name !== undefined || nextCode !== undefined) {
            const duplicate = await tx.restaurantBranch.findFirst({
              where: {
                organizationId: organization,
                id: { not: id },
                OR: [
                  ...(patch.name === undefined
                    ? []
                    : [{ name: { equals: patch.name, mode: 'insensitive' as const } }]),
                  ...(nextCode === undefined ? [] : [{ code: nextCode.toUpperCase() }]),
                ],
              },
              select: { id: true },
            });
            if (duplicate) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'A branch with this name or code already exists.',
              });
            }
          }
          if (isDefault) {
            if (!current.active) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'Activate the branch before making it primary.',
              });
            }
            await tx.restaurantBranch.updateMany({
              where: { organizationId: organization, isDefault: true },
              data: { isDefault: false },
            });
          }
          return tx.restaurantBranch.update({
            where: { id },
            data: {
              ...patch,
              ...(nextCode === undefined ? {} : { code: nextCode.toUpperCase() }),
              ...(isDefault === undefined ? {} : { isDefault }),
            },
          });
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantBranch',
          targetId: branch.id,
          targetLabel: `${branch.name} (${branch.code})`,
          description: `Updated restaurant branch ${branch.code}`,
        });
        return branch;
      } catch (error) {
        mapWriteError(error);
      }
    }),

  setActive: branchProcedure
    .input(z.object({ id: z.string(), active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const organization = organizationId(ctx);
      const branch = await ctx.db.$transaction(async (tx) => {
        const current = await tx.restaurantBranch.findFirst({
          where: { id: input.id, organizationId: organization },
        });
        if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
        if (!input.active) {
          if (current.isDefault) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Choose another primary branch before deactivating this one.',
            });
          }
          const activeCount = await tx.restaurantBranch.count({
            where: { organizationId: organization, active: true },
          });
          if (activeCount <= 1) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'At least one branch must remain active.',
            });
          }
        }
        return tx.restaurantBranch.update({
          where: { id: current.id },
          data: { active: input.active },
        });
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantBranch',
        targetId: branch.id,
        targetLabel: `${branch.name} (${branch.code})`,
        description: `${input.active ? 'Activated' : 'Deactivated'} restaurant branch ${branch.code}`,
      });
      return branch;
    }),
});
