import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, capabilityProcedure, protectedProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import { StaffProfileError } from '@/lib/restaurant/staff';
import { demoDirectoryPolicy } from '@/lib/demo/directory-access';
import { resolveDemoDirectoryScope } from '@/lib/restaurant/staff-branch-authorization';
import { provisionRestaurantOrganization } from '@/lib/restaurant/organization-provisioning';
import {
  CommercialLimitError,
  createStaffProfileWithinCommercialLimit,
  setStaffProfileStatusWithinCommercialLimit,
  updateStaffProfileWithinCommercialLimit,
  withStaffCreationCapacity,
} from '@/lib/restaurant/commercial-limits';
import { createStaffProfile } from '@/lib/restaurant/staff';
import { emailSchema } from '@/lib/email-address';
import { generateInviteToken } from '@/lib/invite-token';
import { appUrl, sendEmail, templates } from '@/lib/email';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import { capabilityMatches } from '@/lib/abac/capabilities';
import type { TRPCContext } from '../trpc';
import {
  CredentialLifecycleError,
  issueOperatorCredential,
  revokeOperatorCredential,
  rotateOperatorCredential,
} from '@/lib/restaurant/credential-lifecycle';
import { CredentialPolicyError } from '@/lib/restaurant/operator-credentials';
import {
  JobRoleError,
  clearStaffCapabilityOverride,
  createJobRole,
  ensureDefaultJobRoles,
  listJobRoles,
  listRoleHoldersAtBranch,
  listStaffCapabilityAudit,
  listStaffCapabilityOverrides,
  listStaffJobRoleAudit,
  listStaffJobRoles,
  resolveStaffCapabilityDecision,
  setJobRoleCapabilities,
  setStaffAccess,
  setStaffCapabilityOverride,
  setStaffJobRoles,
  updateJobRole,
} from '@/lib/restaurant/job-roles';
import {
  assertAuthorizedBranch,
  assertAuthorizedStaffProfile,
  assertOrganizationWide,
  assertStaffProfileExists,
  denyStaffBranchAccess,
  resolveStaffBranchAuthorization,
} from '@/lib/restaurant/staff-branch-authorization';

/**
 * M2-L2 — back-office server surface for restaurant staff CRUD and operator
 * credential issue/rotate/revoke.
 *
 * Every procedure is gated by `capabilityProcedure('staff:manage')`: it audits
 * (mutations and sensitive reads), enforces the licensed module
 * (`restaurant-core`, see `module-catalog.ts`), and runs the ABAC decision for
 * `staff:manage` (org-role driven — see `abac/policies.ts`). Tenant scoping is by
 * the RLS-forced `organizationId` default on every row (C1); no resolver forges
 * an organization id.
 *
 * Credential-bearing mutations set `annotateAudit(..., { skipInput: true })` as
 * their FIRST statement so the plaintext PIN/badge is never captured in the audit
 * log — on the success path AND the failure path, since the audit middleware
 * records failures too (C4). Credential responses never include `credentialHash`.
 */

const STAFF_STATUS = z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']);
const CREDENTIAL_TYPE = z.enum(['PIN', 'BADGE']);
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Translate a staff-domain error into the right tRPC status; rethrow anything else. */
function mapStaffError(err: unknown): never {
  if (err instanceof CommercialLimitError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: err.message });
  }
  if (err instanceof StaffProfileError) {
    const code =
      err.reason === 'EMAIL_TAKEN'
        ? 'CONFLICT'
        : err.reason === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

/** Translate a credential policy/lifecycle error into the right tRPC status; rethrow anything else. */
function mapCredentialError(err: unknown): never {
  if (err instanceof CredentialPolicyError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  if (err instanceof CredentialLifecycleError) {
    const code =
      err.reason === 'ALREADY_EXISTS' || err.reason === 'REVOKED'
        ? 'CONFLICT'
        : err.reason === 'NOT_FOUND' || err.reason === 'STAFF_NOT_FOUND'
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

/** Translate a job-role domain error into the right tRPC status. */
function mapJobRoleError(err: unknown): never {
  if (err instanceof JobRoleError) {
    const code =
      err.reason === 'KEY_TAKEN' || err.reason === 'ROLE_INACTIVE'
        ? 'CONFLICT'
        : err.reason === 'NOT_FOUND' ||
            err.reason === 'BRANCH_NOT_FOUND' ||
            err.reason === 'STAFF_NOT_FOUND'
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

const staffProcedure = capabilityProcedure('staff:manage');

function workspaceOrganizationId(ctx: {
  organization: { id: string } | null;
  session: { user: { organizationId?: string } } | null;
}): string {
  const organizationId = ctx.organization?.id ?? ctx.session?.user.organizationId;
  if (!organizationId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  }
  return organizationId;
}

type InvitePermission = { capability: string; effect: string };

async function canAssignInviteRole(
  ctx: TRPCContext,
  permissions: InvitePermission[],
  accountRole = 'EMPLOYEE'
) {
  const subject = subjectFromSession(ctx.session!.user);
  const options = { db: ctx.db, source: 'TRPC' as const };
  // Organization administrators already have role-assignment authority in team.inviteMember.
  if (await can(subject, 'admin:access', undefined, options)) return true;
  if (accountRole !== 'EMPLOYEE') return false;
  for (const permission of permissions) {
    if (permission.effect !== 'ALLOW') continue;
    // A branch staff manager cannot delegate an open-ended wildcard or a grant
    // they do not hold themselves. Check the actual permissions, never role names.
    if (
      !capabilityMatches(permission.capability, permission.capability) ||
      !(await can(subject, permission.capability as Action, undefined, options))
    )
      return false;
  }
  return true;
}

async function deliverStaffInvite(
  ctx: TRPCContext,
  user: { name: string; email: string },
  role: string,
  token: string
) {
  const inviteUrl = `${appUrl()}/invite/${token}`;
  const mail = templates.inviteMember({
    name: user.name,
    inviterName: ctx.session!.user.name ?? undefined,
    role,
    workspace: 'DevFathom',
    acceptUrl: inviteUrl,
    expiresLabel: 'in 7 days',
  });
  try {
    await sendEmail({ to: { email: user.email, name: user.name }, ...mail });
    return { inviteUrl, emailDelivered: true };
  } catch (error) {
    console.error('[restaurantStaff.invite] invite email failed for', user.email, error);
    return { inviteUrl, emailDelivered: false };
  }
}

export const restaurantStaffRouter = router({
  /**
   * WHA-1181 — does the signed-in user own the staff profile every restaurant
   * procedure resolves them to? Organizations activated before the onboarding
   * fix left their administrator without one, and the only signal was a 403 on
   * every restaurant call. `protectedProcedure` because a user with no profile
   * is exactly the case this has to answer for; it reads nothing but their own
   * link, so it leaks nothing a capability gate would protect.
   */
  mySelfProfile: protectedProcedure.query(async ({ ctx }) => {
    const profile = await ctx.db.restaurantStaffProfile.findFirst({
      where: { userId: ctx.session!.user.id },
      select: { id: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    return { hasProfile: profile !== null, status: profile?.status ?? null };
  }),

  /**
   * The one-time repair behind the workspace call to action. Gated by
   * `staff:manage` (the organization administrator's capability), and it creates
   * only the caller's OWN profile through the same path activation uses.
   *
   * Deliberately outside `createStaffProfileWithinCommercialLimit`: this profile
   * is provisioning the platform owed the administrator at activation, not an
   * operator seat the tenant chose to add — and refusing the repair at the
   * operator cap would strand the administrator in the very 403 loop this fixes.
   */
  provisionMyProfile: staffProcedure.mutation(async ({ ctx }) => {
    const user = ctx.session!.user;
    const organizationId = workspaceOrganizationId(ctx);
    if (user.role !== 'ADMIN' || organizationId !== user.organizationId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Organization administrator access required.',
      });
    }
    assertOrganizationWide(
      await resolveStaffBranchAuthorization(ctx.db, user, ctx.entitlements.organizationId)
    );
    const provisioning = await provisionRestaurantOrganization(ctx.db, {
      organizationId,
      administrators: [{ id: user.id, name: user.name, email: user.email }],
    });
    const result = provisioning.administrators[0]!;
    const repaired =
      result.created ||
      result.roleProfileGranted ||
      provisioning.jobRolesCreated.length > 0 ||
      provisioning.stationsCreated.length > 0;
    if (repaired) {
      annotateAudit(ctx, {
        targetType: 'RestaurantStaffProfile',
        targetId: result.staffProfileId,
        targetLabel: user.name,
        description: 'Provisioned the organization administrator’s own restaurant staff profile',
        metadata: {
          primaryBranchId: result.primaryBranchId,
          selfProvisioned: true,
          profileCreated: result.created,
          roleProfileGranted: result.roleProfileGranted,
          jobRolesCreated: provisioning.jobRolesCreated,
          stationsCreated: provisioning.stationsCreated.map((station) => station.stationId),
        },
      });
    }
    return result;
  }),

  // Shared restaurant consoles consume these directories, but they still expose
  // branch and staff identity. Return only the actor's effective management scope.
  listBranches: protectedProcedure.query(async ({ ctx }) => {
    const authorization =
      (await resolveDemoDirectoryScope(ctx, 'branches', demoDirectoryPolicy)) ??
      (await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      ));
    return ctx.db.restaurantBranch.findMany({
      where: {
        organizationId: workspaceOrganizationId(ctx),
        id: { in: authorization.branchIds },
      },
      select: {
        id: true,
        name: true,
        code: true,
        timezone: true,
        active: true,
        isDefault: true,
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }),

  listDirectory: protectedProcedure
    .input(z.object({ branchId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      if (input?.branchId) assertAuthorizedBranch(authorization, input.branchId);
      const staff = await ctx.db.restaurantStaffProfile.findMany({
        where: {
          organizationId: workspaceOrganizationId(ctx),
          status: 'ACTIVE',
          primaryBranchId: input?.branchId ? input.branchId : { in: authorization.branchIds },
        },
        select: {
          id: true,
          displayName: true,
          user: { select: { title: true, organizationRole: { select: { name: true } } } },
        },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      });
      return staff.map((person) => ({
        id: person.id,
        displayName: person.displayName,
        role: person.user?.organizationRole?.name ?? person.user?.title ?? 'Staff',
      }));
    }),

  listEligibleUsers: staffProcedure.query(({ ctx }) => {
    return ctx.db.user.findMany({
      where: { organizationId: workspaceOrganizationId(ctx) },
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        restaurantStaffProfiles: { select: { id: true, displayName: true }, take: 1 },
      },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    });
  }),

  inviteOptions: staffProcedure.query(async ({ ctx }) => {
    const organizationId = workspaceOrganizationId(ctx);
    const [departments, roles] = await Promise.all([
      ctx.db.organizationDepartment.findMany({
        where: { organizationId, active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, key: true, name: true },
      }),
      ctx.db.organizationRole.findMany({
        where: { organizationId },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          key: true,
          name: true,
          permissions: { select: { capability: true, effect: true } },
        },
      }),
    ]);
    const allowedRoles = [];
    for (const role of roles) {
      if (await canAssignInviteRole(ctx, role.permissions)) {
        allowedRoles.push({ id: role.id, key: role.key, name: role.name });
      }
    }
    return { departments, roles: allowedRoles };
  }),

  invite: staffProcedure
    .input(
      z.object({
        displayName: z.string().min(1).max(200),
        email: emailSchema,
        title: z.string().min(1).max(200),
        department: z
          .string()
          .trim()
          .min(2)
          .max(80)
          .regex(/^[A-Z0-9_]+$/),
        organizationRoleId: z.string().trim().min(1).max(128).nullable().default(null),
        primaryBranchId: z.string().nullable().optional(),
        status: STAFF_STATUS.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      if (!authorization.organizationWide || input.primaryBranchId) {
        assertAuthorizedBranch(authorization, input.primaryBranchId);
      }
      const organizationId = workspaceOrganizationId(ctx);
      const { token, tokenHash } = generateInviteToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      try {
        const result = await withStaffCreationCapacity(
          ctx.db,
          ctx.entitlements.limits,
          async (db, tx) => {
            const department = await tx.organizationDepartment.findFirst({
              where: { organizationId, key: input.department, active: true },
              select: { id: true },
            });
            if (!department)
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid department.' });
            const organizationRole = input.organizationRoleId
              ? await tx.organizationRole.findFirst({
                  where: { id: input.organizationRoleId, organizationId },
                  select: {
                    id: true,
                    name: true,
                    permissions: { select: { capability: true, effect: true } },
                  },
                })
              : null;
            if (input.organizationRoleId && !organizationRole) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid role template.' });
            }
            if (
              organizationRole &&
              !(await canAssignInviteRole(ctx, organizationRole.permissions))
            ) {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'You cannot assign this role template.',
              });
            }
            if (await tx.user.findFirst({ where: { organizationId, email: input.email } })) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'A user with this email already exists',
              });
            }
            const occupiedSeats = await tx.user.count({
              where: { organizationId, status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] } },
            });
            if (occupiedSeats >= ctx.entitlements.seatLimit) {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: `Seat limit reached (${occupiedSeats}/${ctx.entitlements.seatLimit}). Increase the organization license before inviting another member.`,
              });
            }
            const user = await tx.user.create({
              data: {
                organizationId,
                name: input.displayName,
                email: input.email,
                password: null,
                status: 'INVITED',
                role: 'EMPLOYEE',
                department: input.department,
                title: input.title,
                organizationRoleId: organizationRole?.id ?? null,
                skills: [],
              },
            });
            await tx.invitation.create({
              data: {
                organizationId,
                userId: user.id,
                email: input.email,
                tokenHash,
                invitedById: ctx.session!.user.id,
                expiresAt,
              },
            });
            const staff = await createStaffProfile(db, {
              displayName: input.displayName,
              email: input.email,
              userId: user.id,
              primaryBranchId: input.primaryBranchId,
              status: input.status,
            });
            return { user, staff, roleName: organizationRole?.name };
          },
          input.status
        );
        annotateAudit(ctx, {
          targetType: 'RestaurantStaffProfile',
          targetId: result.staff.id,
          targetLabel: result.staff.displayName,
          description: `Invited and created restaurant staff profile "${result.staff.displayName}"`,
          metadata: { userId: result.user.id, primaryBranchId: result.staff.primaryBranchId },
        });
        const delivery = await deliverStaffInvite(
          ctx,
          result.user,
          result.roleName ?? `Employee · ${input.department}`,
          token
        );
        return { ...result.staff, ...delivery };
      } catch (err) {
        mapStaffError(err);
      }
    }),

  resendInvite: staffProcedure
    .input(z.object({ staffProfileId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      await assertAuthorizedStaffProfile(ctx.db, authorization, input.staffProfileId);
      const staff = await ctx.db.restaurantStaffProfile.findUnique({
        where: { id: input.staffProfileId },
        select: {
          id: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              status: true,
              role: true,
              department: true,
              organizationRole: {
                select: { name: true, permissions: { select: { capability: true, effect: true } } },
              },
              permissionOverrides: {
                where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
                select: { capability: true, effect: true },
              },
            },
          },
        },
      });
      const user = staff?.user;
      if (!user || user.status !== 'INVITED') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This staff member has no pending invitation.',
        });
      }
      if (
        !(await canAssignInviteRole(
          ctx,
          [...(user.organizationRole?.permissions ?? []), ...user.permissionOverrides],
          user.role
        ))
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You cannot assign this role template.',
        });
      }
      const { token, tokenHash } = generateInviteToken();
      const changed = await ctx.db.invitation.updateMany({
        where: { organizationId: workspaceOrganizationId(ctx), userId: user.id, acceptedAt: null },
        data: {
          tokenHash,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          invitedById: ctx.session!.user.id,
        },
      });
      if (changed.count !== 1) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This invitation is no longer pending.' });
      }
      annotateAudit(ctx, {
        targetType: 'RestaurantStaffProfile',
        targetId: input.staffProfileId,
        description: 'Resent restaurant staff invitation',
      });
      return {
        id: input.staffProfileId,
        email: user.email,
        ...(await deliverStaffInvite(
          ctx,
          user,
          user.organizationRole?.name ?? `Employee · ${user.department}`,
          token
        )),
      };
    }),

  // ── Staff profiles ────────────────────────────────────────────────────────
  list: staffProcedure
    .input(
      z
        .object({
          status: STAFF_STATUS.optional(),
          branchId: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      if (input?.branchId) assertAuthorizedBranch(authorization, input.branchId);
      return ctx.db.restaurantStaffProfile.findMany({
        where: {
          organizationId: workspaceOrganizationId(ctx),
          ...(input?.status ? { status: input.status } : {}),
          primaryBranchId: input?.branchId ? input.branchId : { in: authorization.branchIds },
        },
        select: {
          id: true,
          displayName: true,
          email: true,
          userId: true,
          user: { select: { status: true } },
          primaryBranchId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          primaryBranch: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    }),

  create: staffProcedure
    .input(
      z.object({
        displayName: z.string().min(1).max(200),
        email: z.string().email().max(320).nullable().optional(),
        userId: z.string().nullable().optional(),
        primaryBranchId: z.string().nullable().optional(),
        status: STAFF_STATUS.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        if (!authorization.organizationWide) {
          assertAuthorizedBranch(authorization, input.primaryBranchId);
        } else if (input.primaryBranchId) {
          assertAuthorizedBranch(authorization, input.primaryBranchId);
        }
        const staff = await createStaffProfileWithinCommercialLimit(
          ctx.db,
          ctx.entitlements.limits,
          input
        );
        annotateAudit(ctx, {
          targetType: 'RestaurantStaffProfile',
          targetId: staff.id,
          targetLabel: staff.displayName,
          description: `Created restaurant staff profile "${staff.displayName}"`,
          metadata: {
            hasUserLink: staff.userId != null,
            primaryBranchId: staff.primaryBranchId,
          },
        });
        return staff;
      } catch (err) {
        mapStaffError(err);
      }
    }),

  update: staffProcedure
    .input(
      z.object({
        id: z.string(),
        displayName: z.string().min(1).max(200).optional(),
        email: z.string().email().max(320).nullable().optional(),
        userId: z.string().nullable().optional(),
        primaryBranchId: z.string().nullable().optional(),
        status: STAFF_STATUS.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        await assertAuthorizedStaffProfile(ctx.db, authorization, id);
        if (patch.primaryBranchId !== undefined && patch.primaryBranchId !== null) {
          assertAuthorizedBranch(authorization, patch.primaryBranchId);
        }
        const staff = await updateStaffProfileWithinCommercialLimit(
          ctx.db,
          ctx.entitlements.limits,
          id,
          patch
        );
        annotateAudit(ctx, {
          targetType: 'RestaurantStaffProfile',
          targetId: staff.id,
          targetLabel: staff.displayName,
          description: `Updated restaurant staff profile "${staff.displayName}"`,
        });
        return staff;
      } catch (err) {
        mapStaffError(err);
      }
    }),

  // Deactivate / reactivate / archive. Status gates operator sign-in (C5,
  // enforced at the terminal in L3); it does not itself revoke credentials.
  setStatus: staffProcedure
    .input(z.object({ id: z.string(), status: STAFF_STATUS }))
    .mutation(async ({ ctx, input }) => {
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        await assertAuthorizedStaffProfile(ctx.db, authorization, input.id);
        const staff = await setStaffProfileStatusWithinCommercialLimit(
          ctx.db,
          ctx.entitlements.limits,
          input.id,
          input.status
        );
        annotateAudit(ctx, {
          targetType: 'RestaurantStaffProfile',
          targetId: staff.id,
          targetLabel: staff.displayName,
          description: `Set restaurant staff profile "${staff.displayName}" status to ${input.status}`,
          metadata: { status: input.status },
        });
        return staff;
      } catch (err) {
        mapStaffError(err);
      }
    }),

  // ── Operator credentials ──────────────────────────────────────────────────
  // Metadata only — `credentialHash` is never selected, so it cannot leak.
  listCredentials: staffProcedure
    .input(z.object({ staffProfileId: z.string(), includeRevoked: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      await assertAuthorizedStaffProfile(ctx.db, authorization, input.staffProfileId);
      return ctx.db.restaurantOperatorCredential.findMany({
        where: {
          staffProfileId: input.staffProfileId,
          ...(input.includeRevoked ? {} : { revokedAt: null }),
        },
        select: {
          id: true,
          staffProfileId: true,
          deviceId: true,
          type: true,
          failedAttempts: true,
          lockedUntil: true,
          revokedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    }),

  issueCredential: staffProcedure
    .input(
      z.object({
        staffProfileId: z.string(),
        type: CREDENTIAL_TYPE,
        secret: z.string().min(1),
        deviceId: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // C4: never let the plaintext secret reach the audit log, even on failure.
      annotateAudit(ctx, { skipInput: true });
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        await assertAuthorizedStaffProfile(ctx.db, authorization, input.staffProfileId);
        if (input.deviceId == null) {
          assertOrganizationWide(authorization);
        } else {
          const device = await ctx.db.restaurantRegisteredDevice.findUnique({
            where: { id: input.deviceId },
            select: { branchId: true },
          });
          if (!device) denyStaffBranchAccess();
          assertAuthorizedBranch(authorization, device.branchId);
        }
        const credential = await issueOperatorCredential(ctx.db, input);
        annotateAudit(ctx, {
          skipInput: true,
          targetType: 'RestaurantOperatorCredential',
          targetId: credential.id,
          description: `Issued ${credential.type} operator credential`,
          metadata: {
            staffProfileId: credential.staffProfileId,
            type: credential.type,
            deviceId: credential.deviceId,
          },
        });
        // Response carries no secret and no hash.
        return {
          id: credential.id,
          staffProfileId: credential.staffProfileId,
          type: credential.type,
          deviceId: credential.deviceId,
          createdAt: credential.createdAt,
        };
      } catch (err) {
        mapCredentialError(err);
      }
    }),

  rotateCredential: staffProcedure
    .input(z.object({ credentialId: z.string(), secret: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        const existing = await ctx.db.restaurantOperatorCredential.findUnique({
          where: { id: input.credentialId },
          select: { staffProfileId: true, deviceId: true, device: { select: { branchId: true } } },
        });
        if (!existing) denyStaffBranchAccess();
        await assertAuthorizedStaffProfile(ctx.db, authorization, existing.staffProfileId);
        if (existing.deviceId == null) assertOrganizationWide(authorization);
        else {
          if (!existing.device) denyStaffBranchAccess();
          assertAuthorizedBranch(authorization, existing.device.branchId);
        }
        const credential = await rotateOperatorCredential(ctx.db, input);
        annotateAudit(ctx, {
          skipInput: true,
          targetType: 'RestaurantOperatorCredential',
          targetId: credential.id,
          description: `Rotated ${credential.type} operator credential`,
          metadata: { type: credential.type },
        });
        return {
          id: credential.id,
          type: credential.type,
          updatedAt: credential.updatedAt,
        };
      } catch (err) {
        mapCredentialError(err);
      }
    }),

  revokeCredential: staffProcedure
    .input(z.object({ credentialId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Uniform C4 treatment for credential-bearing mutations: skip raw-input
      // capture (the credential id is still recorded below as the audit target).
      annotateAudit(ctx, { skipInput: true });
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        const existing = await ctx.db.restaurantOperatorCredential.findUnique({
          where: { id: input.credentialId },
          select: { staffProfileId: true, deviceId: true, device: { select: { branchId: true } } },
        });
        if (!existing) denyStaffBranchAccess();
        await assertAuthorizedStaffProfile(ctx.db, authorization, existing.staffProfileId);
        if (existing.deviceId == null) assertOrganizationWide(authorization);
        else {
          if (!existing.device) denyStaffBranchAccess();
          assertAuthorizedBranch(authorization, existing.device.branchId);
        }
        const credential = await revokeOperatorCredential(ctx.db, input);
        annotateAudit(ctx, {
          skipInput: true,
          targetType: 'RestaurantOperatorCredential',
          targetId: credential.id,
          description: `Revoked ${credential.type} operator credential`,
          metadata: { type: credential.type, revokedAt: credential.revokedAt },
        });
        return {
          id: credential.id,
          type: credential.type,
          revokedAt: credential.revokedAt,
        };
      } catch (err) {
        mapCredentialError(err);
      }
    }),

  // ── Job roles (SOP-1) ─────────────────────────────────────────────────────
  //
  // Job-role administration is staff administration, so it reuses this router's
  // `staff:manage` gate rather than inventing a capability. Every mutation is
  // immediately effective (nothing caches a capability set) and audited twice
  // over: through `annotateAudit` for the back-office trail, and through the
  // append-only `restaurant_staff_job_role_audits` table inside the domain module.

  listJobRoles: staffProcedure
    .input(z.object({ activeOnly: z.boolean().default(false) }).strict())
    .query(({ ctx, input }) => listJobRoles(ctx.db, { activeOnly: input.activeOnly })),

  seedDefaultJobRoles: staffProcedure.mutation(async ({ ctx }) => {
    assertOrganizationWide(
      await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      )
    );
    const result = await ensureDefaultJobRoles(ctx.db);
    if (result.created.length > 0) {
      annotateAudit(ctx, {
        targetType: 'RestaurantJobRole',
        targetId: result.created[0]!,
        description: `Seeded default job roles: ${result.created.join(', ')}`,
      });
    }
    return result;
  }),

  createJobRole: staffProcedure
    .input(
      z
        .object({
          key: z.string().min(1).max(80),
          name: z.string().min(1).max(120),
          description: z.string().max(2_000).nullable().optional(),
          capabilities: z.array(z.string().min(1).max(120)).max(64).default([]),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        assertOrganizationWide(
          await resolveStaffBranchAuthorization(
            ctx.db,
            ctx.session!.user,
            ctx.entitlements.organizationId
          )
        );
        const role = await createJobRole(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantJobRole',
          targetId: role.id,
          description: `Created job role "${role.key}"`,
        });
        return role;
      } catch (err) {
        mapJobRoleError(err);
      }
    }),

  updateJobRole: staffProcedure
    .input(
      z
        .object({
          id: z.string(),
          name: z.string().min(1).max(120).optional(),
          description: z.string().max(2_000).nullable().optional(),
          active: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        assertOrganizationWide(
          await resolveStaffBranchAuthorization(
            ctx.db,
            ctx.session!.user,
            ctx.entitlements.organizationId
          )
        );
        const role = await updateJobRole(ctx.db, id, patch);
        annotateAudit(ctx, {
          targetType: 'RestaurantJobRole',
          targetId: role.id,
          description: `Updated job role "${role.key}"`,
        });
        return role;
      } catch (err) {
        mapJobRoleError(err);
      }
    }),

  setJobRoleCapabilities: staffProcedure
    .input(
      z
        .object({
          jobRoleId: z.string(),
          capabilities: z.array(z.string().min(1).max(120)).max(64),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        assertOrganizationWide(
          await resolveStaffBranchAuthorization(
            ctx.db,
            ctx.session!.user,
            ctx.entitlements.organizationId
          )
        );
        const result = await setJobRoleCapabilities(ctx.db, input.jobRoleId, input.capabilities);
        annotateAudit(ctx, {
          targetType: 'RestaurantJobRole',
          targetId: input.jobRoleId,
          description: `Set job-role capabilities (${input.capabilities.length})`,
        });
        return result;
      } catch (err) {
        mapJobRoleError(err);
      }
    }),

  listStaffJobRoles: staffProcedure
    .input(z.object({ staffProfileId: z.string(), branchId: z.string().optional() }).strict())
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      if (input.branchId) assertAuthorizedBranch(authorization, input.branchId);
      await assertStaffProfileExists(ctx.db, input.staffProfileId);
      const rows = await listStaffJobRoles(ctx.db, input.staffProfileId, {
        branchId: input.branchId,
      });
      return rows.filter((row) => authorization.branchIds.includes(row.branchId));
    }),

  /**
   * The admin console's multi-select save. `jobRoleIds` is the COMPLETE desired
   * set for this person at this branch — roles missing from it are revoked. It is
   * branch-scoped by design: saving the Downtown tab must not disturb the same
   * person's roles at another branch.
   */
  setStaffJobRoles: staffProcedure
    .input(
      z
        .object({
          staffProfileId: z.string(),
          branchId: z.string(),
          jobRoleIds: z.array(z.string()).max(64),
          actorStaffProfileId: z.string().nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        assertAuthorizedBranch(authorization, input.branchId);
        await assertStaffProfileExists(ctx.db, input.staffProfileId);
        const result = await setStaffJobRoles(ctx.db, {
          staffProfileId: input.staffProfileId,
          branchId: input.branchId,
          jobRoleIds: input.jobRoleIds,
          actorStaffProfileId: authorization.actorStaffProfileId,
        });
        if (result.granted.length > 0 || result.revoked.length > 0) {
          annotateAudit(ctx, {
            targetType: 'RestaurantStaffProfile',
            targetId: input.staffProfileId,
            description: `Job roles updated at branch ${input.branchId}: +${result.granted.length} / -${result.revoked.length}`,
            metadata: { granted: result.granted, revoked: result.revoked },
          });
        }
        return result;
      } catch (err) {
        mapJobRoleError(err);
      }
    }),

  /**
   * WHA-1181 — the role-profile dialog's single commit. `jobRoleIds` is the
   * COMPLETE desired role set at this branch (as {@link setStaffJobRoles}), and
   * `overrides` carries only the capabilities the operator actually touched — a
   * `null` effect clears one. Both land in the router's one transaction, so a
   * failed override never leaves the role half of the operator's intent applied.
   */
  setStaffAccess: staffProcedure
    .input(
      z
        .object({
          staffProfileId: z.string(),
          branchId: z.string(),
          jobRoleIds: z.array(z.string()).max(64),
          overrides: z
            .array(
              z
                .object({
                  capability: z.string().min(1).max(120),
                  effect: z.enum(['ALLOW', 'DENY']).nullable(),
                })
                .strict()
            )
            // The console's "Grant all as direct exceptions" stages one entry per
            // capability in the vertical catalog, so the cap has to clear it.
            .max(500)
            .default([]),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        assertAuthorizedBranch(authorization, input.branchId);
        await assertStaffProfileExists(ctx.db, input.staffProfileId);
        const result = await setStaffAccess(ctx.db, {
          staffProfileId: input.staffProfileId,
          branchId: input.branchId,
          jobRoleIds: input.jobRoleIds,
          overrides: input.overrides,
          actorStaffProfileId: authorization.actorStaffProfileId,
        });
        if (result.granted.length || result.revoked.length || result.overrides.length) {
          annotateAudit(ctx, {
            targetType: 'RestaurantStaffProfile',
            targetId: input.staffProfileId,
            description: `Access updated at branch ${input.branchId}: roles +${result.granted.length} / -${result.revoked.length}, ${result.overrides.length} capability override(s)`,
            metadata: {
              granted: result.granted,
              revoked: result.revoked,
              overrides: result.overrides,
            },
          });
        }
        return result;
      } catch (err) {
        mapJobRoleError(err);
      }
    }),

  listStaffJobRoleAudit: staffProcedure
    .input(
      z
        .object({
          staffProfileId: z.string(),
          branchId: z.string().optional(),
          take: z.number().int().min(1).max(500).default(100),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      if (input.branchId) assertAuthorizedBranch(authorization, input.branchId);
      await assertStaffProfileExists(ctx.db, input.staffProfileId);
      const rows = await listStaffJobRoleAudit(ctx.db, input.staffProfileId, {
        branchId: input.branchId,
        take: input.take,
      });
      return rows.filter((row) => authorization.branchIds.includes(row.branchId));
    }),

  /**
   * B1/WHA-285: set ONE person's override for ONE capability at ONE branch.
   * `DENY` takes an inherited capability away from this person only — the role
   * itself is untouched and keeps granting it to everyone else who holds it.
   */
  setStaffCapabilityOverride: staffProcedure
    .input(
      z
        .object({
          staffProfileId: z.string(),
          branchId: z.string(),
          capability: z.string().min(1).max(120),
          effect: z.enum(['ALLOW', 'DENY']),
          actorStaffProfileId: z.string().nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        assertAuthorizedBranch(authorization, input.branchId);
        await assertStaffProfileExists(ctx.db, input.staffProfileId);
        const result = await setStaffCapabilityOverride(ctx.db, {
          staffProfileId: input.staffProfileId,
          branchId: input.branchId,
          capability: input.capability,
          effect: input.effect,
          actorStaffProfileId: authorization.actorStaffProfileId,
        });
        if (result.changed) {
          annotateAudit(ctx, {
            targetType: 'RestaurantStaffProfile',
            targetId: input.staffProfileId,
            description: `Capability ${input.effect === 'DENY' ? 'denied' : 'allowed'}: ${input.capability} at branch ${input.branchId}`,
            metadata: { capability: input.capability, effect: input.effect },
          });
        }
        return result;
      } catch (err) {
        mapJobRoleError(err);
      }
    }),

  /** Remove an override so the person falls back to what their roles grant. */
  clearStaffCapabilityOverride: staffProcedure
    .input(
      z
        .object({
          staffProfileId: z.string(),
          branchId: z.string(),
          capability: z.string().min(1).max(120),
          actorStaffProfileId: z.string().nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const authorization = await resolveStaffBranchAuthorization(
          ctx.db,
          ctx.session!.user,
          ctx.entitlements.organizationId
        );
        assertAuthorizedBranch(authorization, input.branchId);
        await assertStaffProfileExists(ctx.db, input.staffProfileId);
        const result = await clearStaffCapabilityOverride(ctx.db, {
          staffProfileId: input.staffProfileId,
          branchId: input.branchId,
          capability: input.capability,
          actorStaffProfileId: authorization.actorStaffProfileId,
        });
        if (result.changed) {
          annotateAudit(ctx, {
            targetType: 'RestaurantStaffProfile',
            targetId: input.staffProfileId,
            description: `Capability override cleared: ${input.capability} at branch ${input.branchId}`,
            metadata: { capability: input.capability },
          });
        }
        return result;
      } catch (err) {
        mapJobRoleError(err);
      }
    }),

  listStaffCapabilityOverrides: staffProcedure
    .input(z.object({ staffProfileId: z.string(), branchId: z.string().optional() }).strict())
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      if (input.branchId) assertAuthorizedBranch(authorization, input.branchId);
      await assertStaffProfileExists(ctx.db, input.staffProfileId);
      const rows = await listStaffCapabilityOverrides(ctx.db, input.staffProfileId, {
        branchId: input.branchId,
      });
      return rows.filter((row) => authorization.branchIds.includes(row.branchId));
    }),

  listStaffCapabilityAudit: staffProcedure
    .input(
      z
        .object({
          staffProfileId: z.string(),
          branchId: z.string().optional(),
          take: z.number().int().min(1).max(500).default(100),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      if (input.branchId) assertAuthorizedBranch(authorization, input.branchId);
      await assertStaffProfileExists(ctx.db, input.staffProfileId);
      const rows = await listStaffCapabilityAudit(ctx.db, input.staffProfileId, {
        branchId: input.branchId,
        take: input.take,
      });
      return rows.filter((row) => authorization.branchIds.includes(row.branchId));
    }),

  /**
   * What this person may actually do at one branch, and why. `effective` is the
   * authorization answer; the other three sets are the layers it came from, so a
   * console can show "denied despite the supervisor role" rather than a bare gap.
   */
  resolveStaffCapabilities: staffProcedure
    .input(z.object({ staffProfileId: z.string(), branchId: z.string() }).strict())
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      assertAuthorizedBranch(authorization, input.branchId);
      await assertStaffProfileExists(ctx.db, input.staffProfileId);
      const decision = await resolveStaffCapabilityDecision(
        ctx.db,
        input.staffProfileId,
        input.branchId
      );
      return {
        capabilities: [...decision.effective].sort(),
        inherited: [...decision.inherited].sort(),
        allowed: [...decision.allowed].sort(),
        denied: [...decision.denied].sort(),
      };
    }),

  /** Who could be assigned a role's pooled work at a branch. */
  listRoleHolders: staffProcedure
    .input(z.object({ jobRoleId: z.string(), branchId: z.string() }).strict())
    .query(async ({ ctx, input }) => {
      const authorization = await resolveStaffBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        ctx.entitlements.organizationId
      );
      assertAuthorizedBranch(authorization, input.branchId);
      return listRoleHoldersAtBranch(ctx.db, input.jobRoleId, input.branchId);
    }),
});
