import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import { Prisma } from '@/generated/prisma/client';
import { OPEN_ATTEMPT_STATUSES } from '@/lib/pharmacy/card-terminal/open-attempts';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { annotateAudit } from '@/server/audit';

import { adminProcedure, assertModuleLicensed, router, type TRPCContext } from '../trpc';

const PHARMACY_ASSIGNABLE_ROLE_KEYS = new Set(PHARMACY_ROLE_TEMPLATES.map((role) => role.key));

const memberSelect = {
  id: true,
  name: true,
  email: true,
  organizationRole: {
    select: {
      key: true,
      name: true,
      permissions: { select: { capability: true, effect: true } },
    },
  },
} as const;

type AssignableRole = {
  key: string;
  name: string;
  permissions: { capability: string; effect: string }[];
};

function pharmacyOrganizationId(ctx: TRPCContext): string {
  const organizationId = ctx.entitlements?.organizationId;
  const user = ctx.session?.user;
  if (!organizationId || !user?.id) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (
    ctx.organization?.vertical !== 'PHARMACY' ||
    ctx.organization.id !== organizationId ||
    user.organizationId !== organizationId
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  }
  return organizationId;
}

function pharmacyCapability(capability: string): boolean {
  return (
    capability === '*' || capability.startsWith('pharmacy.') || capability.startsWith('pharmacy:')
  );
}

export function mayAssignPharmacyBranch(role: AssignableRole | null): boolean {
  if (!role) return false;
  if (PHARMACY_ASSIGNABLE_ROLE_KEYS.has(role.key)) return true;
  return role.permissions.some(
    (rule) => rule.effect === 'ALLOW' && pharmacyCapability(rule.capability)
  );
}

async function assignableMember(ctx: TRPCContext, organizationId: string, userId: string) {
  const member = await ctx.db.user.findFirst({
    where: {
      id: userId,
      organizationId,
      status: { in: [...ACTIVE_STATUSES] as Array<'ACTIVE' | 'ON_LEAVE'> },
    },
    select: memberSelect,
  });
  if (!member || !mayAssignPharmacyBranch(member.organizationRole)) return null;
  return member;
}

/** DEV-907: owner authority comes from the live member row, never the session role. */
async function isOwner(
  ctx: TRPCContext,
  organizationId: string,
  db: Pick<TRPCContext['db'], 'user'> = ctx.db
): Promise<boolean> {
  const actor = await db.user.findFirst({
    where: { id: ctx.session!.user.id, organizationId },
    select: {
      status: true,
      role: true,
      organizationRole: {
        select: {
          key: true,
          isSystem: true,
          permissions: { select: { capability: true, effect: true } },
        },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  return Boolean(actor && hasAllCapabilityAccess(actor));
}

export const pharmacyBranchAssignmentsRouter = router({
  cashModes: adminProcedure.query(async ({ ctx }) => {
    assertModuleLicensed(ctx, 'pharmacy-core');
    const organizationId = pharmacyOrganizationId(ctx);
    if (ctx.support || ctx.session.user.isSupportSession || !(await isOwner(ctx, organizationId)))
      return null;
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId, active: true },
      select: { id: true, name: true, code: true, cashShiftsEnabled: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
  }),

  setCashMode: adminProcedure
    .input(z.strictObject({ branchId: z.string().trim().min(1).max(128), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      assertModuleLicensed(ctx, 'pharmacy-core');
      const organizationId = pharmacyOrganizationId(ctx);
      const actorId = ctx.session.user.id;
      const forbidden = () =>
        new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the pharmacy owner can change how a branch closes.',
        });
      if (ctx.support || ctx.session.user.isSupportSession) throw forbidden();
      return ctx.db.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM users WHERE id = ${actorId} AND "organizationId" = ${organizationId} FOR SHARE`
        );
        if (!(await isOwner(ctx, organizationId, tx))) throw forbidden();
        const where = { organizationId, id: input.branchId, active: true };
        const branch = await tx.pharmacyBranch.findFirst({
          where,
          select: { cashShiftsEnabled: true },
        });
        if (!branch)
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Choose an active branch in this pharmacy.',
          });
        if (branch.cashShiftsEnabled !== input.enabled) {
          // Drawer opening and terminal preflight hold the shared side through commit.
          await tx.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_branches
            WHERE id = ${input.branchId} AND "organizationId" = ${organizationId} FOR UPDATE`);
          const scope = { organizationId, branchId: input.branchId };
          if (
            await tx.pharmacyCardTerminalAttempt.count({
              where: { ...scope, status: { in: [...OPEN_ATTEMPT_STATUSES] } },
            })
          )
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'A card payment at this branch is still being finished. Settle or resolve it, then change how the branch closes.',
            });
          const open = { ...scope, status: 'OPEN' as const };
          if (await tx.pharmacyCashShift.count({ where: open }))
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'Close the open cash shifts and drawers at this branch before changing how it closes.',
            });
          if (await tx.pharmacyDrawerSession.count({ where: open }))
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Close the open drawers at this branch before changing how it closes.',
            });

          const updated = await tx.pharmacyBranch.updateMany({
            where: { ...where, cashShiftsEnabled: branch.cashShiftsEnabled },
            data: { cashShiftsEnabled: input.enabled },
          });
          if (!updated.count)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'The branch changed while you were editing. Reload and try again.',
            });
          await tx.auditLog.create({
            data: {
              organizationId,
              actorId,
              actorType: 'USER',
              source: 'TRPC',
              category: 'PHARMACY',
              operation: 'UPDATE',
              action: 'pharmacy.branch.cashMode',
              targetType: 'PharmacyBranch',
              targetId: input.branchId,
              outcome: 'SUCCESS',
              changes: {
                cashShiftsEnabled: { before: branch.cashShiftsEnabled, after: input.enabled },
              },
            },
          });
        }
        return { enabled: input.enabled };
      });
    }),

  /** DEV-907: the owner's "also in stock at another branch" counter switch. */
  otherBranchAvailability: adminProcedure.query(async ({ ctx }) => {
    const organizationId = pharmacyOrganizationId(ctx);
    const [organization, owner] = await Promise.all([
      ctx.db.organization.findUnique({
        where: { id: organizationId },
        select: { pharmacyOtherBranchAvailability: true },
      }),
      isOwner(ctx, organizationId),
    ]);
    return {
      enabled: organization?.pharmacyOtherBranchAvailability === true,
      canChange: owner,
    };
  }),

  /** DEV-907: only the owner turns the line on or off; every change is audited. */
  setOtherBranchAvailability: adminProcedure
    .input(z.object({ enabled: z.boolean() }).strict())
    .mutation(async ({ ctx, input }) => {
      const organizationId = pharmacyOrganizationId(ctx);
      if (!(await isOwner(ctx, organizationId))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the owner can change this setting.',
        });
      }
      const saved = await ctx.db.organization.update({
        where: { id: organizationId },
        data: { pharmacyOtherBranchAvailability: input.enabled },
        select: { pharmacyOtherBranchAvailability: true },
      });
      annotateAudit(ctx, {
        operation: 'UPDATE',
        targetType: 'Organization',
        targetId: organizationId,
        description: `${saved.pharmacyOtherBranchAvailability ? 'Turned on' : 'Turned off'} other-branch availability at the counter`,
        metadata: { pharmacyOtherBranchAvailability: saved.pharmacyOtherBranchAvailability },
      });
      return { enabled: saved.pharmacyOtherBranchAvailability };
    }),

  list: adminProcedure.query(async ({ ctx }) => {
    const organizationId = pharmacyOrganizationId(ctx);
    const [branches, people, rows] = await Promise.all([
      ctx.db.pharmacyBranch.findMany({
        where: { organizationId, active: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
      }),
      ctx.db.user.findMany({
        where: {
          organizationId,
          status: { in: [...ACTIVE_STATUSES] as Array<'ACTIVE' | 'ON_LEAVE'> },
        },
        select: memberSelect,
        orderBy: { name: 'asc' },
      }),
      ctx.db.pharmacyBranchAssignment.findMany({
        where: { organizationId, active: true },
        select: { id: true, branchId: true, userId: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const members = people.flatMap((person) =>
      mayAssignPharmacyBranch(person.organizationRole)
        ? [
            {
              id: person.id,
              name: person.name,
              email: person.email,
              roleName: person.organizationRole?.name ?? 'Member',
            },
          ]
        : []
    );
    const branchName = new Map(branches.map((branch) => [branch.id, branch.name]));
    const memberName = new Map(members.map((member) => [member.id, member.name]));
    return {
      branches,
      members,
      assignments: rows.flatMap((row) => {
        const userName = memberName.get(row.userId);
        const assignedBranch = branchName.get(row.branchId);
        if (!userName || !assignedBranch) return [];
        return [
          {
            id: row.id,
            branchId: row.branchId,
            userId: row.userId,
            branchName: assignedBranch,
            userName,
          },
        ];
      }),
    };
  }),

  assign: adminProcedure
    .input(
      z
        .object({
          branchId: z.string().trim().min(1).max(128),
          userId: z.string().trim().min(1).max(128),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = pharmacyOrganizationId(ctx);
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { id: input.branchId, organizationId, active: true },
        select: { id: true },
      });
      if (!branch) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
      }
      const member = await assignableMember(ctx, organizationId, input.userId);
      if (!member) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'That member cannot be assigned to a pharmacy branch.',
        });
      }
      const row = await ctx.db.pharmacyBranchAssignment.upsert({
        where: {
          organizationId_branchId_userId: {
            organizationId,
            branchId: input.branchId,
            userId: input.userId,
          },
        },
        create: {
          organizationId,
          branchId: input.branchId,
          userId: input.userId,
          active: true,
        },
        update: { active: true },
        select: { id: true },
      });
      annotateAudit(ctx, {
        targetType: 'PharmacyBranchAssignment',
        targetId: row.id,
        metadata: { action: 'assign', branchId: input.branchId, userId: input.userId },
      });
      return { id: row.id };
    }),

  unassign: adminProcedure
    .input(z.object({ assignmentId: z.string().trim().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) => {
      const organizationId = pharmacyOrganizationId(ctx);
      const row = await ctx.db.pharmacyBranchAssignment.findFirst({
        where: { id: input.assignmentId, organizationId, active: true },
        select: { id: true, branchId: true, userId: true },
      });
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Assignment was not found.' });
      await ctx.db.pharmacyBranchAssignment.update({
        where: { id: row.id },
        data: { active: false },
      });
      annotateAudit(ctx, {
        targetType: 'PharmacyBranchAssignment',
        targetId: row.id,
        metadata: { action: 'unassign', branchId: row.branchId, userId: row.userId },
      });
      return { id: row.id };
    }),
});
