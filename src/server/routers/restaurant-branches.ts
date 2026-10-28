import { assignOwnersToBranch } from '@/lib/restaurant/owner-branch-assignments';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { Prisma } from '@/generated/prisma/client';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { annotateAudit } from '../audit';
import { capabilityProcedure, router } from '../trpc';
import { resolveEntitlementLimit, RESTAURANT_LOCATIONS_LIMIT } from '@/lib/entitlement-limits';

const branchProcedure = capabilityProcedure('restaurant:configure');
const code = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(24)
  .regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'Use letters, numbers, and single hyphens.');
const timezone = z
  .string()
  .trim()
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Use a valid IANA timezone, such as Asia/Karachi.');
const editableFields = z
  .object({
    name: z.string().trim().min(2).max(120),
    timezone,
    businessDayCutoff: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    address: z.string().trim().max(300).nullable(),
    shiftSignInEnforced: z.boolean(),
  })
  .strict();
const createFields = editableFields.extend({ code });

function locationsLimit(limits: Record<string, number>): number {
  const resolution = resolveEntitlementLimit(limits, RESTAURANT_LOCATIONS_LIMIT);
  if (resolution.status === 'missing') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The restaurant location entitlement is not configured correctly.',
    });
  }
  return resolution.value;
}

async function lockOrganization(
  tx: { $queryRaw: (query: Prisma.Sql) => Promise<unknown> },
  id: string
) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
}

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
      Promise.resolve(locationsLimit(ctx.entitlements.limits as Record<string, number>)),
    ]);
    return { branches, limit };
  }),

  create: branchProcedure.input(createFields).mutation(async ({ ctx, input }) => {
    const organization = organizationId(ctx);
    const limit = locationsLimit(ctx.entitlements.limits as Record<string, number>);
    try {
      const branch = await ctx.db.$transaction(async (tx) => {
        await lockOrganization(tx, organization);
        const count = await tx.restaurantBranch.count({
          where: { organizationId: organization, active: true },
        });
        if (count >= limit) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Your plan supports ${limit} active branch${limit === 1 ? '' : 'es'}.`,
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
        const created = await tx.restaurantBranch.create({
          data: {
            ...input,
            code: input.code,
            organizationId: organization,
            active: true,
            isDefault: count === 0,
          },
        });
        await assignOwnersToBranch(tx as unknown as ScopedDb, organization, created.id);
        return created;
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
    .input(
      editableFields.partial().extend({ id: z.string(), isDefault: z.literal(true).optional() })
    )
    .mutation(async ({ ctx, input }) => {
      const organization = organizationId(ctx);
      const { id, isDefault, ...patch } = input;
      try {
        const branch = await ctx.db.$transaction(async (tx) => {
          await lockOrganization(tx, organization);
          const current = await tx.restaurantBranch.findFirst({
            where: { id, organizationId: organization },
          });
          if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
          if (patch.name !== undefined) {
            const duplicate = await tx.restaurantBranch.findFirst({
              where: {
                organizationId: organization,
                id: { not: id },
                name: { equals: patch.name, mode: 'insensitive' },
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
      const limit = locationsLimit(ctx.entitlements.limits as Record<string, number>);
      const branch = await ctx.db.$transaction(async (tx) => {
        await lockOrganization(tx, organization);
        let makeDefault = false;
        const current = await tx.restaurantBranch.findFirst({
          where: { id: input.id, organizationId: organization },
        });
        if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
        if (input.active && !current.active) {
          const activeCount = await tx.restaurantBranch.count({
            where: { organizationId: organization, active: true },
          });
          if (activeCount >= limit) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: `Your plan supports ${limit} active branch${limit === 1 ? '' : 'es'}.`,
            });
          }
          const activePrimary = await tx.restaurantBranch.findFirst({
            where: { organizationId: organization, active: true, isDefault: true },
            select: { id: true },
          });
          makeDefault = activePrimary === null;
        } else if (!input.active && current.active) {
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
          const [devices, staff, openOrders, openDrawers, scheduledShifts] = await Promise.all([
            tx.restaurantRegisteredDevice.count({
              where: { branchId: current.id, status: 'ACTIVE' },
            }),
            tx.restaurantStaffProfile.count({
              where: { primaryBranchId: current.id, status: 'ACTIVE' },
            }),
            tx.restaurantOrder.count({
              where: {
                branchId: current.id,
                status: { notIn: ['CLOSED', 'CANCELLED'] },
              },
            }),
            tx.restaurantDrawerSession.count({
              where: { branchId: current.id, status: 'OPEN' },
            }),
            tx.restaurantShift.count({
              where: { branchId: current.id, status: 'SCHEDULED', endAt: { gt: new Date() } },
            }),
          ]);
          if (devices || staff || openOrders || openDrawers || scheduledShifts) {
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'This branch still has active terminals, assigned staff, open orders or drawers, or scheduled shifts. Reassign, close, or cancel them before deactivating the branch; operational history will remain available.',
            });
          }
        }
        const updated = await tx.restaurantBranch.update({
          where: { id: current.id },
          data: { active: input.active, ...(makeDefault ? { isDefault: true } : {}) },
        });
        if (input.active && !current.active) {
          await assignOwnersToBranch(tx as unknown as ScopedDb, organization, current.id);
        }
        return updated;
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
