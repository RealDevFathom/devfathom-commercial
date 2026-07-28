import { createHash, randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { assertSeatAvailable } from '@/lib/entitlements';
import { encryptSecret } from '@/lib/secret-crypto';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';
import { adminProcedure, router } from '@/server/trpc';

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

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function organizationId(ctx: { session: { user: { organizationId?: string } } }): string {
  const id = ctx.session.user.organizationId;
  if (!id) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  return id;
}

export const organizationAdminRouter = router({
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
        deploymentMode: true,
        timezone: true,
        locale: true,
        currency: true,
        primaryContactName: true,
        primaryContactEmail: true,
        activatedAt: true,
        package: { select: { name: true } },
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
    return {
      organization: {
        ...organization,
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
        timezone: z.string().trim().min(1).max(100),
        locale: z.string().trim().min(2).max(20),
        primaryContactName: z.string().trim().max(150).nullable(),
        primaryContactEmail: optionalEmail,
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
          .regex(/^[a-z0-9._-]+$/),
        name: z.string().trim().min(2).max(150),
        description: z.string().trim().max(500).nullable(),
        permissions: z
          .array(
            z.object({
              capability: z.string().trim().min(1).max(150),
              effect: z.enum(['ALLOW', 'DENY']),
            })
          )
          .max(250),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const { id: roleId, permissions, ...values } = input;
      const existing = roleId
        ? await ctx.db.organizationRole.findFirst({
            where: { id: roleId, organizationId: id },
          })
        : null;
      if (existing?.isSystem) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'System roles cannot be modified.' });
      }
      const role = roleId
        ? await ctx.db.organizationRole.update({ where: { id: roleId }, data: values })
        : await ctx.db.organizationRole.create({ data: { organizationId: id, ...values } });
      await ctx.db.organizationRolePermission.deleteMany({
        where: { organizationRoleId: role.id },
      });
      if (permissions.length) {
        await ctx.db.organizationRolePermission.createMany({
          data: permissions.map((permission) => ({
            organizationId: id,
            organizationRoleId: role.id,
            ...permission,
          })),
        });
      }
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
        department: z.enum([
          'LEADERSHIP',
          'ENGINEERING',
          'PRODUCT',
          'QUALITY',
          'MARKETING',
          'DESIGN',
        ]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const before = await ctx.db.user.findFirst({
        where: { id: input.id, organizationId: id },
        select: { id: true, status: true, role: true, email: true },
      });
      if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
      const activating =
        !['ACTIVE', 'ON_LEAVE', 'INVITED'].includes(before.status) &&
        ['ACTIVE', 'ON_LEAVE', 'INVITED'].includes(input.status);
      if (activating) {
        try {
          assertSeatAvailable(ctx.entitlements);
        } catch (error) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: error instanceof Error ? error.message : 'No license seat is available.',
          });
        }
      }
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
      const saved = await ctx.db.user.update({
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

  resetMemberPassword: adminProcedure
    .input(z.object({ id: z.string(), password: z.string().min(12).max(256) }))
    .mutation(async ({ ctx, input }) => {
      const id = organizationId(ctx);
      const user = await ctx.db.user.findFirst({
        where: { id: input.id, organizationId: id },
        select: { id: true, email: true },
      });
      if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found.' });
      await ctx.db.user.update({
        where: { id: user.id },
        data: {
          password: await hash(input.password, 12),
          passwordChangedAt: new Date(),
          tokenVersion: { increment: 1 },
        },
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
