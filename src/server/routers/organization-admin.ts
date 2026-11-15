import { createHash, randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import {
  askFathomAvailability,
  readAskFathomAvailability,
  readRoutedAvailabilityFor,
  readAskFathomSettings,
} from '@/lib/ai/ask-fathom-settings';
import { readDeepStrategySettings } from '@/lib/ai/deep-strategy-settings';
import { readAIProviderReadiness } from '@/lib/ai/provider';
import { passwordSchema } from '@/lib/password-policy';
import { adminPasswordResetData } from '@/lib/auth/admin-password-reset';
import { organizationRolePermissionsSchema } from '@/lib/organization-role';
import { encryptSecret } from '@/lib/secret-crypto';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { ianaTimezone } from '@/lib/timezone';
import { annotateAudit } from '@/server/audit';
import { adminProcedure, protectedProcedure, router } from '@/server/trpc';

const optionalUrl = z
  .union([z.url().max(2_000), z.literal('')])
  .transform((value) => value || null);
const optionalEmail = z
  .union([z.email().max(254), z.literal('')])
  .transform((value) => value.trim().toLowerCase() || null);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const departmentKey = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[A-Z0-9_]+$/, 'Use uppercase letters, numbers, and underscores only.');
const OCCUPIED_SEAT_STATUSES = ['ACTIVE', 'ON_LEAVE', 'INVITED'] as const;

function occupiesSeat(status: string): boolean {
  return (OCCUPIED_SEAT_STATUSES as readonly string[]).includes(status);
}

function duplicateMember(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

async function lockOrganizationSeat(
  tx: Prisma.TransactionClient,
  organizationId: string,
  seatLimit: number
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR UPDATE`;
  const activeSeats = await tx.user.count({
    where: { organizationId, status: { in: [...OCCUPIED_SEAT_STATUSES] } },
  });
  if (activeSeats >= seatLimit) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Seat limit reached (${activeSeats}/${seatLimit}).`,
    });
  }
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function organizationId(ctx: { session: { user: { organizationId?: string } } }): string {
  const id = ctx.session.user.organizationId;
  if (!id) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  return id;
}

export const organizationAdminRouter = router({
  // Shares POST /api/assistant's availability check: the launcher is enabled only when
  // the company switch is on and the AI provider is configured.
  askFathomSettings: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    const check = await readAskFathomAvailability(ctx.db, organizationId(ctx));
    if (!check) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
    return check.availability;
  }),

  setAskFathomEnabled: adminProcedure
    .input(z.strictObject({ askFathomEnabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // A custom capability grant must not broaden this company control beyond ADMIN.
      if (ctx.session.user.role !== 'ADMIN') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator access is required.' });
      }
      const id = organizationId(ctx);
      const settings = await readAskFathomSettings(ctx.db, id);
      if (!settings) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
      const saved = await ctx.db.organization.update({
        where: { id },
        data: { askFathomEnabled: input.askFathomEnabled },
        select: { id: true, askFathomEnabled: true },
      });
      annotateAudit(ctx, {
        targetType: 'Organization',
        targetId: id,
        operation: 'UPDATE',
        description: `${saved.askFathomEnabled ? 'Enabled' : 'Disabled'} company Ask Fathom chat`,
      });
      const provider = readAIProviderReadiness();
      return askFathomAvailability(
        { organizationId: saved.id, askFathomEnabled: saved.askFathomEnabled },
        provider,
        await readRoutedAvailabilityFor(provider)
      );
    }),

  // The pharmacy's opt-in for deep strategy on the deep model. ADMIN only; no UI yet.
  deepStrategySettings: adminProcedure.input(z.void()).query(async ({ ctx }) => {
    if (ctx.session.user.role !== 'ADMIN') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator access is required.' });
    }
    const settings = await readDeepStrategySettings(ctx.db, organizationId(ctx));
    if (!settings) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
    return settings;
  }),

  setDeepStrategyEnabled: adminProcedure
    .input(z.strictObject({ aiDeepStrategyEnabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // A custom capability grant must not broaden this company control beyond ADMIN.
      if (ctx.session.user.role !== 'ADMIN') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Administrator access is required.' });
      }
      const id = organizationId(ctx);
      const settings = await readDeepStrategySettings(ctx.db, id);
      if (!settings) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
      const saved = await ctx.db.organization.update({
        where: { id },
        data: { aiDeepStrategyEnabled: input.aiDeepStrategyEnabled },
        select: { id: true, aiDeepStrategyEnabled: true },
      });
      annotateAudit(ctx, {
        targetType: 'Organization',
        targetId: id,
        operation: 'UPDATE',
        description: `${saved.aiDeepStrategyEnabled ? 'Enabled' : 'Disabled'} AI deep strategy`,
      });
      // The router caches the opt-in for up to 30 seconds per server.
      return { organizationId: saved.id, aiDeepStrategyEnabled: saved.aiDeepStrategyEnabled };
    }),

  departments: adminProcedure.query(async ({ ctx }) => {
    const id = organizationId(ctx);
    return ctx.db.organizationDepartment.findMany({
      where: { organizationId: id },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }),

  roles: adminProcedure.query(async ({ ctx }) => {
    const id = organizationId(ctx);
    return ctx.db.organizationRole.findMany({
      where: { organizationId: id },
      orderBy: { name: 'asc' },
      select: { id: true, key: true, name: true },
    });
  }),

  upsertDepartment: adminProcedure
    .input(
      z.object({
        id: z.string().optional(),
        key: departmentKey,
        name: z.string().trim().min(2).max(100),
        active: z.boolean().default(true),
        sortOrder: z.number().int().min(0).max(10_000).default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const tenantId = organizationId(ctx);
      const { id, ...values } = input;
      const existing = id
        ? await ctx.db.organizationDepartment.findFirst({ where: { id, organizationId: tenantId } })
        : null;
      if (id && !existing)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Department not found.' });
      if (existing && existing.key !== values.key) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Department keys cannot be changed.' });
      }
      const saved = existing
        ? await ctx.db.organizationDepartment.update({ where: { id: existing.id }, data: values })
        : await ctx.db.organizationDepartment.create({
            data: { organizationId: tenantId, ...values },
          });
      annotateAudit(ctx, {
        targetType: 'OrganizationDepartment',
        targetId: saved.id,
        targetLabel: saved.name,
        description: `${existing ? 'Updated' : 'Created'} organization department`,
      });
      return saved;
    }),

  removeDepartment: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = organizationId(ctx);
      const department = await ctx.db.organizationDepartment.findFirst({
        where: { id: input.id, organizationId: tenantId },
        include: { _count: { select: { users: true } } },
      });
      if (!department) throw new TRPCError({ code: 'NOT_FOUND', message: 'Department not found.' });
      if (department._count.users > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Reassign ${department._count.users} member(s) before removing this department.`,
        });
      }
      await ctx.db.organizationDepartment.delete({ where: { id: department.id } });
      annotateAudit(ctx, {
        targetType: 'OrganizationDepartment',
        targetId: department.id,
        targetLabel: department.name,
        description: 'Removed organization department',
      });
      return { success: true };
    }),

  overview: adminProcedure.query(async ({ ctx }) => {
    const id = organizationId(ctx);
    const organization = await ctx.db.organization.findUnique({
      where: { id },
      select: {
        id: true,
        slug: true,
        legalName: true,
        displayName: true,
        status: true,
        vertical: true,
        deploymentMode: true,
        timezone: true,
        locale: true,
        currency: true,
        primaryContactName: true,
        primaryContactEmail: true,
        invoiceAddress: true,
        taxId: true,
        activatedAt: true,
        packageId: true,
        brand: true,
        emailSettings: {
          select: {
            id: true,
            provider: true,
            fromName: true,
            fromAddress: true,
            replyTo: true,
            encryptedApiKey: true,
            domainVerifiedAt: true,
            configuration: true,
          },
        },
        domains: { orderBy: [{ isPrimary: 'desc' }, { host: 'asc' }] },
        identityConnections: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            name: true,
            protocol: true,
            status: true,
            domains: true,
            allowJit: true,
            enforceSso: true,
            lastTestedAt: true,
            lastError: true,
          },
        },
        scimTokens: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            name: true,
            prefix: true,
            expiresAt: true,
            lastUsedAt: true,
            revokedAt: true,
            createdAt: true,
          },
        },
        departments: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, key: true, name: true },
        },
        roles: {
          orderBy: { name: 'asc' },
          include: {
            permissions: { orderBy: { capability: 'asc' } },
            _count: { select: { users: true } },
          },
        },
        users: {
          orderBy: [{ role: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            status: true,
            title: true,
            department: true,
            organizationRoleId: true,
            lastActiveAt: true,
          },
        },
        usageCounters: { orderBy: { updatedAt: 'desc' }, take: 25 },
      },
    });
    if (!organization) throw new TRPCError({ code: 'NOT_FOUND' });
    // Package catalog rows are control-plane-only under RLS. Use only the
    // package assigned to this session's organization, and expose its name.
    const assignedPackage = organization.packageId
      ? await withPlatformDb((db) =>
          db.platformPackage.findUnique({
            where: { id: organization.packageId! },
            select: { name: true },
          })
        )
      : null;
    const pharmacyBranches = await ctx.db.pharmacyBranch.findMany({
      where: { organizationId: id, active: true },
      select: { id: true, name: true, code: true },
      orderBy: { name: 'asc' },
    });
    return {
      pharmacyBranches,
      organization: {
        ...organization,
        package: assignedPackage,
        emailSettings: organization.emailSettings
          ? {
              ...organization.emailSettings,
              encryptedApiKey: Boolean(organization.emailSettings.encryptedApiKey),
            }
          : null,
      },
      entitlements: ctx.entitlements,
    };
  }),

  updateProfile: adminProcedure
    .input(
      z.object({
        displayName: z.string().trim().min(1).max(150),
        // Every screen that shows a workspace time formats in this zone, and
        // Intl throws on one it does not know: the platform's IANA check.
        timezone: ianaTimezone,
        locale: z.string().trim().min(2).max(20),
        primaryContactName: z.string().trim().max(150).nullable(),
        primaryContactEmail: optionalEmail,
        // Printed on client-facing invoices as the seller's address and tax ID.
        invoiceAddress: z.string().trim().max(500).nullish(),
        taxId: z.string().trim().max(100).nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const saved = await ctx.db.organization.update({ where: { id }, data: input });
      annotateAudit(ctx, {
        targetType: 'Organization',
        targetId: id,
        targetLabel: saved.displayName,
        description: 'Updated organization workspace profile',
      });
      return saved;
    }),

  updateBrand: adminProcedure
    .input(
      z.object({
        logoUrl: optionalUrl,
        markUrl: optionalUrl,
        faviconUrl: optionalUrl,
        primaryColor: hexColor,
        accentColor: hexColor,
        supportEmail: optionalEmail,
        fromName: z.string().trim().max(150).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const saved = await ctx.db.organizationBrand.upsert({
        where: { organizationId: id },
        update: { ...input, updatedById: ctx.session.user.id },
        create: { organizationId: id, ...input, updatedById: ctx.session.user.id },
      });
      annotateAudit(ctx, {
        targetType: 'OrganizationBrand',
        targetId: saved.id,
        description: 'Updated organization brand',
      });
      return saved;
    }),

  updateEmail: adminProcedure
    .input(
      z.object({
        provider: z.string().trim().min(2).max(80),
        fromName: z.string().trim().max(150).nullable(),
        fromAddress: optionalEmail,
        replyTo: optionalEmail,
        apiKey: z.string().trim().min(8).max(2_000).optional(),
        configuration: z.record(z.string(), z.unknown()).default({}),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const { apiKey, configuration, ...values } = input;
      const saved = await ctx.db.organizationEmailSettings.upsert({
        where: { organizationId: id },
        update: {
          ...values,
          encryptedApiKey: apiKey ? encryptSecret(apiKey) : undefined,
          configuration: inputJson(configuration),
        },
        create: {
          organizationId: id,
          ...values,
          encryptedApiKey: apiKey ? encryptSecret(apiKey) : null,
          configuration: inputJson(configuration),
        },
      });
      annotateAudit(ctx, {
        targetType: 'OrganizationEmailSettings',
        targetId: saved.id,
        description: 'Updated organization email delivery settings',
        metadata: { provider: saved.provider, credentialUpdated: Boolean(apiKey) },
      });
      return { ...saved, encryptedApiKey: Boolean(saved.encryptedApiKey) };
    }),

  upsertRole: adminProcedure
    .input(
      z.object({
        id: z.string().optional(),
        key: z
          .string()
          .trim()
          .min(2)
          .max(80)
          .regex(
            /^[a-z0-9._-]+$/,
            'Use lowercase letters, numbers, dots, underscores, and hyphens only.'
          ),
        name: z.string().trim().min(2).max(150),
        description: z.string().trim().max(500).nullable(),
        permissions: organizationRolePermissionsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const { id: roleId, permissions, ...values } = input;
      const role = await ctx.db.$transaction(async (tx) => {
        // Serialize role replacements for this tenant so concurrent edits cannot
        // interleave their delete/insert sequences.
        await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${id} FOR UPDATE`;
        const existing = roleId
          ? await tx.organizationRole.findFirst({ where: { id: roleId, organizationId: id } })
          : null;
        if (roleId && !existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Role not found.' });
        }
        if (existing?.isSystem) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'System roles cannot be modified.' });
        }
        const saved = roleId
          ? await tx.organizationRole.update({ where: { id: roleId }, data: values })
          : await tx.organizationRole.create({ data: { organizationId: id, ...values } });
        await tx.organizationRolePermission.deleteMany({
          where: { organizationRoleId: saved.id },
        });
        if (permissions.length) {
          await tx.organizationRolePermission.createMany({
            data: permissions.map((permission) => ({
              organizationId: id,
              organizationRoleId: saved.id,
              ...permission,
            })),
          });
        }
        return saved;
      });
      annotateAudit(ctx, {
        targetType: 'OrganizationRole',
        targetId: role.id,
        targetLabel: role.name,
        description: `${roleId ? 'Updated' : 'Created'} organization role`,
        metadata: { permissions },
      });
      return role;
    }),

  removeRole: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const role = await ctx.db.organizationRole.findFirst({
        where: { id: input.id, organizationId: id },
        include: { _count: { select: { users: true } } },
      });
      if (!role) throw new TRPCError({ code: 'NOT_FOUND', message: 'Role not found.' });
      if (role.isSystem) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'System roles cannot be removed.' });
      }
      if (role._count.users > 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Reassign ${role._count.users} member(s) before removing this role.`,
        });
      }
      await ctx.db.organizationRole.delete({ where: { id: role.id } });
      annotateAudit(ctx, {
        targetType: 'OrganizationRole',
        targetId: role.id,
        targetLabel: role.name,
        description: 'Removed organization role',
      });
      return { success: true };
    }),

  updateMember: adminProcedure
    .input(
      z.object({
        id: z.string(),
        role: z.enum(['ADMIN', 'HR', 'EMPLOYEE']),
        status: z.enum(['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'INVITED']),
        organizationRoleId: z.string().nullable(),
        title: z.string().trim().min(1).max(150),
        department: departmentKey,
      })
    )
    // DEV-828: never hand back the whole User row (password verifier, TOTP seed).
    .output(z.object({ id: z.string(), email: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const before = await ctx.db.user.findFirst({
        where: { id: input.id, organizationId: id },
        select: { id: true, status: true, role: true, email: true },
      });
      if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
      const department = await ctx.db.organizationDepartment.findFirst({
        where: { organizationId: id, key: input.department, active: true },
        select: { id: true },
      });
      if (!department) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid department.' });
      const activating = !occupiesSeat(before.status) && occupiesSeat(input.status);
      if (input.organizationRoleId) {
        const role = await ctx.db.organizationRole.findFirst({
          where: { id: input.organizationRoleId, organizationId: id },
          select: { id: true },
        });
        if (!role) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid custom role.' });
      }
      if (before.id === ctx.session.user.id && input.status === 'INACTIVE') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You cannot deactivate yourself.' });
      }
      const saved = await ctx.db.$transaction(async (tx) => {
        const removesActiveAdmin =
          before.role === 'ADMIN' &&
          before.status === 'ACTIVE' &&
          (input.role !== 'ADMIN' || input.status !== 'ACTIVE');

        // Serialize every transition that can remove an active admin. Reading the
        // count before taking this lock would let two concurrent demotions both
        // observe the other admin and leave the organization with none.
        if (removesActiveAdmin) {
          await tx.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${id} FOR UPDATE`;
          const activeAdmins = await tx.user.count({
            where: { organizationId: id, role: 'ADMIN', status: 'ACTIVE' },
          });
          if (activeAdmins <= 1) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Cannot demote or deactivate the last active admin.',
            });
          }
        } else if (activating) {
          await lockOrganizationSeat(tx, id, ctx.entitlements.seatLimit);
        }
        return tx.user.update({
          where: { id: input.id },
          data: {
            role: input.role,
            status: input.status,
            organizationRoleId: input.organizationRoleId,
            title: input.title,
            department: input.department,
            tokenVersion:
              before.role !== input.role || before.status !== input.status
                ? { increment: 1 }
                : undefined,
          },
          select: { id: true, email: true },
        });
      });
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: saved.id,
        targetLabel: saved.email,
        description: 'Updated member access and role',
        metadata: { before, after: input },
      });
      return saved;
    }),

  createMember: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(150),
        email: z
          .email()
          .max(254)
          .transform((value) => value.trim().toLowerCase()),
        password: passwordSchema.min(12).max(256),
        title: z.string().trim().min(1).max(150),
        role: z.enum(['ADMIN', 'HR', 'EMPLOYEE']),
        department: departmentKey,
        organizationRoleId: z.string().nullable().default(null),
        branchIds: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const department = await ctx.db.organizationDepartment.findFirst({
        where: { organizationId: id, key: input.department, active: true },
        select: { id: true },
      });
      if (!department) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid department.' });
      if (input.organizationRoleId) {
        const role = await ctx.db.organizationRole.findFirst({
          where: { id: input.organizationRoleId, organizationId: id },
          select: { id: true },
        });
        if (!role) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid custom role.' });
      }
      const existing = await ctx.db.user.findFirst({
        where: { organizationId: id, email: input.email },
        select: { id: true },
      });
      if (existing)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A member with this email already exists in this workspace.',
        });
      const branchIds = [...new Set(input.branchIds)];
      const created = await ctx.db.$transaction(async (tx) => {
        await lockOrganizationSeat(tx, id, ctx.entitlements.seatLimit);
        if (branchIds.length > 0) {
          const branches = await tx.pharmacyBranch.findMany({
            where: { organizationId: id, id: { in: branchIds }, active: true },
            select: { id: true },
          });
          if (branches.length !== branchIds.length) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Choose an active pharmacy branch.',
            });
          }
        }
        let member;
        try {
          member = await tx.user.create({
            data: {
              organizationId: id,
              name: input.name,
              email: input.email,
              password: await hash(input.password, 12),
              passwordChangedAt: null,
              mustChangePassword: true,
              role: input.role,
              department: input.department,
              title: input.title,
              organizationRoleId: input.organizationRoleId,
              status: 'ACTIVE',
            },
            select: { id: true, email: true, name: true },
          });
        } catch (error) {
          if (duplicateMember(error)) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'A member with this email already exists in this workspace.',
            });
          }
          throw error;
        }
        if (branchIds.length > 0) {
          await tx.pharmacyBranchAssignment.createMany({
            data: branchIds.map((branchId) => ({
              organizationId: id,
              branchId,
              userId: member.id,
              active: true,
            })),
          });
        }
        return member;
      });
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: created.id,
        targetLabel: created.email,
        operation: 'CREATE',
        description: 'Added a workspace member',
        metadata: { role: input.role, department: input.department },
      });
      return created;
    }),

  resetMemberPassword: adminProcedure
    .input(z.object({ id: z.string(), password: passwordSchema.min(12).max(256) }))
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const user = await ctx.db.user.findFirst({
        where: { id: input.id, organizationId: id },
        select: { id: true, email: true },
      });
      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
      await ctx.db.user.update({
        where: { id: user.id },
        data: adminPasswordResetData(await hash(input.password, 12)),
      });
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: user.id,
        targetLabel: user.email,
        description: 'Reset member password and revoked existing sessions',
      });
      return { success: true };
    }),

  addDomain: adminProcedure
    .input(
      z.object({ host: hostname, kind: z.string().trim().min(2).max(30), isPrimary: z.boolean() })
    )
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      if (input.isPrimary) {
        await ctx.db.organizationDomain.updateMany({
          where: { organizationId: id },
          data: { isPrimary: false },
        });
      }
      const domain = await ctx.db.organizationDomain.create({
        data: {
          organizationId: id,
          ...input,
          verificationToken: randomBytes(24).toString('base64url'),
        },
      });
      await withPlatformDb((db) =>
        db.platformJob.create({
          data: {
            organizationId: id,
            type: 'CONFIGURE_DOMAIN',
            requestedById: ctx.session.user.id,
            payload: { domainId: domain.id, host: domain.host, requestedByTenant: true },
          },
        })
      );
      annotateAudit(ctx, {
        targetType: 'OrganizationDomain',
        targetId: domain.id,
        targetLabel: domain.host,
        description: 'Added organization domain and queued verification',
      });
      return domain;
    }),

  retryDomain: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const domain = await ctx.db.organizationDomain.findFirst({
        where: { id: input.id, organizationId: id },
      });
      if (!domain) throw new TRPCError({ code: 'NOT_FOUND', message: 'Domain not found.' });
      await ctx.db.organizationDomain.update({
        where: { id: domain.id },
        data: { verificationStatus: 'PENDING', failureReason: null },
      });
      const job = await withPlatformDb((db) =>
        db.platformJob.create({
          data: {
            organizationId: id,
            type: 'CONFIGURE_DOMAIN',
            requestedById: ctx.session.user.id,
            payload: { domainId: domain.id, host: domain.host, requestedByTenant: true },
          },
        })
      );
      return { jobId: job.id };
    }),

  createScimToken: adminProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(150),
        expiresAt: z.date().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      if (!ctx.entitlements.enabledModules.includes('identity')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'The identity module is not licensed.',
        });
      }
      const token = `scim_${randomBytes(32).toString('base64url')}`;
      const saved = await ctx.db.organizationScimToken.create({
        data: {
          organizationId: id,
          name: input.name,
          prefix: token.slice(0, 16),
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: input.expiresAt,
        },
      });
      annotateAudit(ctx, {
        targetType: 'OrganizationScimToken',
        targetId: saved.id,
        targetLabel: saved.name,
        description: 'Created SCIM provisioning token',
        metadata: { prefix: saved.prefix, expiresAt: saved.expiresAt },
      });
      return { ...saved, tokenHash: undefined, token };
    }),

  revokeScimToken: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const token = await ctx.db.organizationScimToken.findFirst({
        where: { id: input.id, organizationId: id },
      });
      if (!token) throw new TRPCError({ code: 'NOT_FOUND', message: 'Token not found.' });
      const saved = await ctx.db.organizationScimToken.update({
        where: { id: token.id },
        data: { revokedAt: new Date() },
      });
      annotateAudit(ctx, {
        targetType: 'OrganizationScimToken',
        targetId: saved.id,
        targetLabel: saved.name,
        description: 'Revoked SCIM provisioning token',
      });
      return saved;
    }),
});
