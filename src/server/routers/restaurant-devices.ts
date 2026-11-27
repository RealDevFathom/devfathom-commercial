import { TRPCError } from '@trpc/server';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import { demoDirectoryPolicy } from '@/lib/demo/directory-access';
import { resolveDemoDirectoryScope } from '@/lib/restaurant/staff-branch-authorization';
import { z } from 'zod';

import {
  CoAuthorizationError,
  buildCoAuthorizationRecord,
} from '@/lib/restaurant/co-authorization';
import {
  DeviceLifecycleError,
  deviceHealth,
  revokeDevice,
  rotateDeviceSecret,
} from '@/lib/restaurant/devices';
import { staffHasCapability } from '@/lib/restaurant/job-roles';
import {
  PrinterInventoryError,
  PrinterRenameError,
  PrinterRetirementError,
  printerRegistrationsSchema,
  printerRenameSchema,
  printerRetirementSchema,
  publicPrinterSelect,
  registerPrintersForExistingBridge,
  renamePrinterInventory,
  retirePrinterInventory,
} from '@/lib/restaurant/printer-inventory';
import { withCommittedApproverCheck } from '@/lib/restaurant/approver-authentication';
import { authenticateOperator } from '@/lib/restaurant/terminal-auth';
import { authenticateApproverWithinBudget } from '@/lib/restaurant/approver-attempt-budget';
import {
  CommercialLimitError,
  enrollDeviceWithinCommercialLimits,
  enrollPrintBridgeWithinCommercialLimits,
} from '@/lib/restaurant/commercial-limits';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { RestaurantApproverRight } from '@/lib/approval-approver-rights';
import {
  assertActorEligibleForBranch,
  assertAuthorizedBranch,
  denyStaffBranchAccess,
  resolveCapabilityBranchAuthorization,
} from '@/lib/restaurant/staff-branch-authorization';
import { annotateAudit } from '../audit';
import { auditedProtectedProcedure, capabilityProcedure, router } from '../trpc';
import { refuseSupportSession } from '@/lib/tenancy/support-session-rule';

const manageDevicesProcedure = capabilityProcedure('devices:manage');
const coAuthorizationApprovalCapability = 'coauth:approve' satisfies RestaurantApproverRight;

async function assertApproverCanCoAuthorize(
  db: ScopedDb,
  staffProfileId: string,
  branchId: string
) {
  if (
    !(await staffHasCapability(db, staffProfileId, branchId, coAuthorizationApprovalCapability))
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The approving staff member lacks co-authorization approval permission.',
    });
  }
}

/**
 * Revocation is its own capability, never implied by `devices:manage`. Like
 * `menu:publish`, it is an organization-role capability outside the ABAC action
 * union, so `can()` resolves it through the role grant and default-denies.
 */
const DEVICES_REVOKE = 'devices:revoke' as Action;

type RevokeAuthorizationContext = {
  db: ScopedDb;
  session: { user: Parameters<typeof resolveCapabilityBranchAuthorization>[1] } | null;
  entitlements: { organizationId?: string | null };
  requestMeta: { ip: string | null };
};

/**
 * Resolve the branches where the actor may revoke devices. A branch actor needs
 * `devices:revoke` on that branch's job role; an organization-wide actor
 * (`restaurant:configure`) must also hold `devices:revoke` on their organization
 * role, because configuring the restaurant does not grant revocation.
 */
async function resolveRevokeAuthorization(ctx: RevokeAuthorizationContext) {
  const user = ctx.session!.user;
  const authorization = await resolveCapabilityBranchAuthorization(ctx.db, user, 'devices:revoke', {
    organizationId: ctx.entitlements.organizationId,
    requireExactlyOneActiveActor: true,
  });
  if (
    authorization.organizationWide &&
    !(await can(subjectFromSession(user), DEVICES_REVOKE, undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }))
  ) {
    denyStaffBranchAccess();
  }
  return authorization;
}

/** Branches whose devices the actor may revoke; only drives the console's Revoke affordance. */
async function revocableBranchIds(ctx: RevokeAuthorizationContext): Promise<Set<string>> {
  try {
    return new Set((await resolveRevokeAuthorization(ctx)).branchIds);
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') return new Set();
    throw error;
  }
}

/**
 * M2-L3 / §5 / C7 — back-office device administration.
 *
 * Admins enroll and revoke terminal devices from the web console. Revocation is
 * the representative CO-AUTHORIZED sensitive action of M2: it requires a distinct
 * approving manager who proves their OWN operator credential (durable lockout via
 * `authenticateOperator`) and is recorded as an L1 co-authorization row (acting +
 * approving staff, capability, target, reason, server timestamp). Approval ADDS
 * the manager's identity; it never replaces the acting admin (C6/C7).
 *
 * The raw device secret is returned by `initiateEnrollment` exactly once and is
 * never persisted or echoed again; no procedure ever returns `deviceSecretHash`.
 */
export const restaurantDevicesRouter = router({
  /** Issue a one-use enrollment code only while creating a new bridge. */
  initiatePrintBridgeEnrollment: manageDevicesProcedure
    .meta(refuseSupportSession)
    .input(
      z
        .object({
          branchId: z.string().min(1),
          name: z.string().trim().min(1).max(120),
          printers: printerRegistrationsSchema.optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const authorization = await resolveCapabilityBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        'devices:manage',
        { organizationId: ctx.entitlements.organizationId }
      );
      assertAuthorizedBranch(authorization, input.branchId);
      const branch = await ctx.db.restaurantBranch.findFirst({
        where: { id: input.branchId, active: true },
        select: { id: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Active branch not found.' });
      try {
        const { device, enrollment, printerCount } = await enrollPrintBridgeWithinCommercialLimits(
          ctx.db,
          ctx.entitlements.limits,
          input
        );
        annotateAudit(ctx, {
          targetType: 'RestaurantRegisteredDevice',
          targetId: device.id,
          targetLabel: device.name,
          description: `Enrolled print bridge "${device.name}"`,
          metadata: { branchId: device.branchId, kind: device.kind, printerCount },
        });
        return {
          device: {
            id: device.id,
            name: device.name,
            branchId: device.branchId,
            kind: device.kind,
          },
          enrollmentCode: enrollment.code,
          expiresAt: enrollment.expiresAt,
          printerCount,
        };
      } catch (error) {
        if (error instanceof CommercialLimitError || error instanceof PrinterInventoryError)
          throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
        throw error;
      }
    }),

  /** Inventory is management-only; the existing demo-aware device directory is unchanged. */
  listPrinters: manageDevicesProcedure
    .input(z.object({ branchId: z.string().min(1) }).strict())
    .query(async ({ ctx, input }) => {
      const authorization = await resolveCapabilityBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        'devices:manage',
        { organizationId: ctx.entitlements.organizationId }
      );
      assertAuthorizedBranch(authorization, input.branchId);
      return ctx.db.restaurantPrinter.findMany({
        where: { branchId: input.branchId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: publicPrinterSelect,
      });
    }),

  registerPrinters: manageDevicesProcedure
    .input(
      z
        .object({
          branchId: z.string().min(1),
          bridgeId: z.string().min(1),
          printers: printerRegistrationsSchema,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const authorization = await resolveCapabilityBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        'devices:manage',
        { organizationId: ctx.entitlements.organizationId }
      );
      assertAuthorizedBranch(authorization, input.branchId);
      try {
        const registered = await registerPrintersForExistingBridge(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantRegisteredDevice',
          targetId: input.bridgeId,
          description: 'Registered printer inventory',
          metadata: { branchId: input.branchId, registered },
        });
        return { registered };
      } catch (error) {
        if (error instanceof PrinterInventoryError)
          throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
        throw error;
      }
    }),

  renamePrinter: manageDevicesProcedure
    .input(printerRenameSchema)
    .mutation(async ({ ctx, input }) => {
      const authorization = await resolveCapabilityBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        'devices:manage',
        { organizationId: ctx.entitlements.organizationId }
      );
      assertAuthorizedBranch(authorization, input.branchId);
      try {
        const result = await renamePrinterInventory(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantPrinter',
          targetId: result.printer.id,
          targetLabel: result.printer.name,
          description: result.changed
            ? 'Renamed printer inventory label'
            : 'Printer inventory label unchanged',
          metadata: {
            branchId: result.printer.branchId,
            bridgeId: result.bridgeId,
            previousName: result.previousName,
            changed: result.changed,
          },
        });
        return { printer: result.printer, changed: result.changed };
      } catch (error) {
        if (error instanceof PrinterRenameError)
          throw new TRPCError({ code: error.code, message: error.message });
        throw error;
      }
    }),

  retirePrinter: manageDevicesProcedure
    .input(printerRetirementSchema)
    .mutation(async ({ ctx, input }) => {
      const authorization = await resolveCapabilityBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        'devices:manage',
        { organizationId: ctx.entitlements.organizationId }
      );
      assertAuthorizedBranch(authorization, input.branchId);
      try {
        const result = await retirePrinterInventory(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantPrinter',
          targetId: result.printer.id,
          targetLabel: result.printer.name,
          description: result.changed
            ? 'Retired printer inventory'
            : 'Printer inventory already retired',
          metadata: {
            branchId: result.printer.branchId,
            bridgeId: result.bridgeId,
            retiredAt: result.printer.retiredAt.toISOString(),
            changed: result.changed,
          },
        });
        return { printer: result.printer, changed: result.changed };
      } catch (error) {
        if (error instanceof PrinterRetirementError)
          throw new TRPCError({ code: error.code, message: error.message });
        throw error;
      }
    }),

  /** List registered devices with derived operational health (no secret material). */
  list: auditedProtectedProcedure.query(async ({ ctx }) => {
    let authorization = await resolveDemoDirectoryScope(ctx, 'devices', demoDirectoryPolicy);
    // Branches where `revoke` would accept this actor; the server re-checks on revoke.
    let revokeBranchIds = new Set<string>();
    if (!authorization) {
      if (
        !(await can(subjectFromSession(ctx.session!.user), 'devices:manage', undefined, {
          db: ctx.db,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        }))
      )
        denyStaffBranchAccess();
      authorization = await resolveCapabilityBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        'devices:manage',
        { organizationId: ctx.entitlements.organizationId }
      );
      revokeBranchIds = await revocableBranchIds(ctx);
    }
    const now = new Date();
    const devices = await ctx.db.restaurantRegisteredDevice.findMany({
      where: { branchId: { in: authorization.branchIds } },
      orderBy: { createdAt: 'desc' },
      include: { branch: { select: { id: true, name: true } } },
    });
    return devices.map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      branch: device.branch,
      stationId: device.stationId,
      status: device.status,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
      createdAt: device.createdAt,
      health: deviceHealth(device, now),
      canRevoke: device.status !== 'REVOKED' && revokeBranchIds.has(device.branchId),
    }));
  }),

  /** Minimal co-authorization directory for one authorized device branch. */
  listApprovers: manageDevicesProcedure
    .input(z.object({ deviceId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const authorization = await resolveCapabilityBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        'devices:manage',
        { organizationId: ctx.entitlements.organizationId, requireExactlyOneActiveActor: true }
      );
      const actingStaffProfileId = authorization.actorStaffProfileId;
      if (!actingStaffProfileId) denyStaffBranchAccess();

      const device = await ctx.db.restaurantRegisteredDevice.findUnique({
        where: { id: input.deviceId },
        select: { branchId: true },
      });
      if (!device) denyStaffBranchAccess();
      assertAuthorizedBranch(authorization, device.branchId);
      assertActorEligibleForBranch(authorization, device.branchId);

      const actingStaff = await ctx.db.restaurantStaffProfile.findUnique({
        where: { id: actingStaffProfileId },
        select: { id: true, displayName: true },
      });
      if (!actingStaff) denyStaffBranchAccess();

      const candidates = await ctx.db.restaurantStaffProfile.findMany({
        where: {
          organizationId: ctx.organization?.id ?? ctx.session!.user.organizationId,
          id: { not: actingStaffProfileId },
          status: 'ACTIVE',
          OR: [
            { primaryBranchId: device.branchId },
            { jobRoles: { some: { branchId: device.branchId } } },
            { directCapabilityGrants: { some: { branchId: device.branchId } } },
          ],
        },
        select: { id: true, displayName: true },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      });
      const eligibility = await Promise.all(
        candidates.map(async (profile) => ({
          profile,
          eligible: await staffHasCapability(
            ctx.db,
            profile.id,
            device.branchId,
            coAuthorizationApprovalCapability
          ),
        }))
      );

      return {
        actingStaff,
        approvers: eligibility.filter(({ eligible }) => eligible).map(({ profile }) => profile),
      };
    }),

  /** Enroll a device to a branch; returns the one-time enrollment secret. */
  initiateEnrollment: manageDevicesProcedure
    .meta(refuseSupportSession)
    .input(
      z.object({
        branchId: z.string().min(1),
        name: z.string().min(1).max(120),
        kind: z.enum(['POS', 'KDS']).optional(),
        stationId: z.string().min(1).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const authorization = await resolveCapabilityBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        'devices:manage',
        { organizationId: ctx.entitlements.organizationId }
      );
      assertAuthorizedBranch(authorization, input.branchId);
      const organizationId = ctx.session!.user.organizationId;
      if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const branch = await ctx.db.restaurantBranch.findFirst({
        where: { id: input.branchId, organizationId, active: true },
        select: { id: true },
      });
      if (!branch) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
      }
      const kind = input.kind ?? 'POS';
      if (kind === 'KDS') {
        if (!input.stationId) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'KDS station is required.' });
        }
        const station = await ctx.db.restaurantKitchenStation.findFirst({
          where: { id: input.stationId, branchId: input.branchId, active: true },
          select: { id: true },
        });
        if (!station) throw new TRPCError({ code: 'NOT_FOUND', message: 'Station not found.' });
      }

      let enrollment;
      try {
        enrollment = await enrollDeviceWithinCommercialLimits(ctx.db, ctx.entitlements.limits, {
          branchId: input.branchId,
          name: input.name,
          kind,
          stationId: kind === 'KDS' ? input.stationId : null,
        });
      } catch (error) {
        if (error instanceof CommercialLimitError) {
          throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
        }
        throw error;
      }
      const { device, secret } = enrollment;

      annotateAudit(ctx, {
        targetType: 'RestaurantRegisteredDevice',
        targetId: device.id,
        targetLabel: device.name,
        description: `Enrolled terminal device "${device.name}"`,
        metadata: { branchId: input.branchId },
      });

      return {
        device: {
          id: device.id,
          name: device.name,
          branchId: device.branchId,
          status: device.status,
          kind: device.kind,
          stationId: device.stationId,
        },
        // Delivered ONCE — the caller must surface it to the device operator now.
        enrollmentSecret: secret,
      };
    }),

  /**
   * Revoke a device WITH manager co-authorization (C7). Validates the two-identity
   * co-authorization invariants, verifies the approving manager's credential, then
   * atomically writes the co-authorization evidence and flips the device to
   * REVOKED. `skipInput` keeps the approving secret out of the audit log (C4).
   */
  revoke: manageDevicesProcedure
    .meta(refuseSupportSession)
    .input(
      z.object({
        deviceId: z.string().min(1),
        // Accepted temporarily for existing clients, but never trusted as actor identity.
        actingStaffProfileId: z.string().min(1).optional(),
        approvingStaffProfileId: z.string().min(1),
        approvingType: z.enum(['PIN', 'BADGE']),
        approvingSecret: z.string().min(1),
        reason: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });

      // Revocation is its own capability: `devices:manage` (the procedure gate)
      // is not enough. The acting identity must hold `devices:revoke` for the
      // device's branch before any approval evidence is built or persisted.
      const authorization = await resolveRevokeAuthorization(ctx);
      const actingStaffProfileId = authorization.actorStaffProfileId;
      if (!actingStaffProfileId) denyStaffBranchAccess();

      const device = await ctx.db.restaurantRegisteredDevice.findUnique({
        where: { id: input.deviceId },
      });
      if (!device) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found.' });
      }
      assertAuthorizedBranch(authorization, device.branchId);
      assertActorEligibleForBranch(authorization, device.branchId);
      if (device.status === 'REVOKED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Device is already revoked.' });
      }

      // The approving identity must exist and be ACTIVE in this organization.
      const approving = await ctx.db.restaurantStaffProfile.findUnique({
        where: { id: input.approvingStaffProfileId },
        select: { id: true, status: true },
      });
      if (!approving || approving.status !== 'ACTIVE') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Approving manager profile is not active.',
        });
      }

      // Validate the two-identity invariants BEFORE spending a bcrypt compare.
      let record;
      try {
        record = buildCoAuthorizationRecord({
          actingStaffProfileId,
          approvingStaffProfileId: input.approvingStaffProfileId,
          capability: 'devices:revoke',
          reason: input.reason,
          targetType: 'RestaurantRegisteredDevice',
          targetId: device.id,
        });
      } catch (err) {
        if (err instanceof CoAuthorizationError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
        }
        throw err;
      }

      await assertApproverCanCoAuthorize(ctx.db, input.approvingStaffProfileId, device.branchId);
      const now = new Date();
      // DEV-1055: a wrong credential fails this request and rolls its transaction
      // back. The credential check therefore commits in its own tenant
      // transaction, so its strike lands on the same durable counter the terminal
      // routes use; the per-approver budget stays as a second, outer limit.
      const approverOrganizationId =
        ctx.entitlements.organizationId ?? ctx.session!.user.organizationId;
      const auth = await authenticateApproverWithinBudget(
        approverOrganizationId,
        input.approvingStaffProfileId,
        () =>
          withCommittedApproverCheck(
            approverOrganizationId,
            { staffProfileId: input.approvingStaffProfileId, type: input.approvingType },
            (tx) =>
              authenticateOperator(tx, {
                staffProfileId: input.approvingStaffProfileId,
                type: input.approvingType,
                secret: input.approvingSecret,
                now,
                approval: {
                  action: 'restaurantDevices.revoke',
                  approverRight: coAuthorizationApprovalCapability,
                  requestedByStaffProfileId: actingStaffProfileId,
                },
              })
          )
      );
      if (!auth.ok) {
        if (auth.reason === 'LOCKED') {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Approving manager credential is temporarily locked.',
          });
        }
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid approving credential.' });
      }

      // The whole tRPC request runs inside one tenant transaction (the fetch
      // adapter wraps it in `withTenantDb`), so writing the evidence and then
      // revoking are atomic: if either fails, the request transaction rolls back
      // and neither the co-authorization nor the revocation persists.
      const coAuthorization = await ctx.db.restaurantCoAuthorization.create({ data: record });
      const revoked = await revokeDevice(ctx.db, device.id, now);

      annotateAudit(ctx, {
        targetType: 'RestaurantRegisteredDevice',
        targetId: device.id,
        targetLabel: device.name,
        description: `Revoked terminal device "${device.name}" with manager co-authorization`,
        metadata: {
          coAuthorizationId: coAuthorization.id,
          actingStaffProfileId,
          approvingStaffProfileId: input.approvingStaffProfileId,
        },
      });

      return {
        device: { id: revoked.id, status: revoked.status },
        coAuthorizationId: coAuthorization.id,
      };
    }),

  /** Rotate an active device secret with the same two-person approval as revoke. */
  rotate: manageDevicesProcedure
    .meta(refuseSupportSession)
    .input(
      z
        .object({
          deviceId: z.string().min(1),
          approvingStaffProfileId: z.string().min(1),
          approvingType: z.enum(['PIN', 'BADGE']),
          approvingSecret: z.string().min(1),
          reason: z.string().min(1),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      const authorization = await resolveCapabilityBranchAuthorization(
        ctx.db,
        ctx.session!.user,
        'devices:manage',
        { organizationId: ctx.entitlements.organizationId, requireExactlyOneActiveActor: true }
      );
      const actingStaffProfileId = authorization.actorStaffProfileId;
      if (!actingStaffProfileId) denyStaffBranchAccess();
      const device = await ctx.db.restaurantRegisteredDevice.findUnique({
        where: { id: input.deviceId },
      });
      if (!device) denyStaffBranchAccess();
      assertAuthorizedBranch(authorization, device.branchId);
      assertActorEligibleForBranch(authorization, device.branchId);
      if (device.status === 'REVOKED' || device.revokedAt !== null) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A revoked device cannot be rotated.',
        });
      }

      const approving = await ctx.db.restaurantStaffProfile.findUnique({
        where: { id: input.approvingStaffProfileId },
        select: { id: true, status: true },
      });
      if (!approving || approving.status !== 'ACTIVE') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Approving manager profile is not active.',
        });
      }
      let record;
      try {
        record = buildCoAuthorizationRecord({
          actingStaffProfileId,
          approvingStaffProfileId: input.approvingStaffProfileId,
          capability: 'devices:manage',
          reason: input.reason,
          targetType: 'RestaurantRegisteredDevice',
          targetId: device.id,
        });
      } catch (err) {
        if (err instanceof CoAuthorizationError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
        }
        throw err;
      }

      await assertApproverCanCoAuthorize(ctx.db, input.approvingStaffProfileId, device.branchId);
      // DEV-1055: a wrong credential fails this request and rolls its transaction
      // back. The credential check therefore commits in its own tenant
      // transaction, so its strike lands on the same durable counter the terminal
      // routes use; the per-approver budget stays as a second, outer limit.
      const approverOrganizationId =
        ctx.entitlements.organizationId ?? ctx.session!.user.organizationId;
      const auth = await authenticateApproverWithinBudget(
        approverOrganizationId,
        input.approvingStaffProfileId,
        () =>
          withCommittedApproverCheck(
            approverOrganizationId,
            { staffProfileId: input.approvingStaffProfileId, type: input.approvingType },
            (tx) =>
              authenticateOperator(tx, {
                staffProfileId: input.approvingStaffProfileId,
                type: input.approvingType,
                secret: input.approvingSecret,
                now: new Date(),
                approval: {
                  action: 'restaurantDevices.rotate',
                  approverRight: coAuthorizationApprovalCapability,
                  requestedByStaffProfileId: actingStaffProfileId,
                },
              })
          )
      );
      if (!auth.ok) {
        if (auth.reason === 'LOCKED') {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Approving manager credential is temporarily locked.',
          });
        }
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid approving credential.' });
      }

      try {
        const { result, coAuthorization } = await ctx.db.$transaction(async (tx) => {
          const result = await rotateDeviceSecret(
            tx as unknown as ScopedDb,
            device.id,
            device.deviceSecretHash
          );
          const coAuthorization = await tx.restaurantCoAuthorization.create({ data: record });
          return { result, coAuthorization };
        });
        annotateAudit(ctx, {
          skipInput: true,
          targetType: 'RestaurantRegisteredDevice',
          targetId: device.id,
          targetLabel: device.name,
          description: `Rotated terminal device "${device.name}" with manager co-authorization`,
          metadata: {
            coAuthorizationId: coAuthorization.id,
            actingStaffProfileId,
            approvingStaffProfileId: input.approvingStaffProfileId,
          },
        });
        return {
          device: { id: result.device.id, status: result.device.status },
          secret: result.secret,
          coAuthorizationId: coAuthorization.id,
        };
      } catch (err) {
        if (err instanceof DeviceLifecycleError) {
          throw new TRPCError({
            code:
              err.reason === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : err.reason === 'STALE_ROTATION'
                  ? 'CONFLICT'
                  : 'BAD_REQUEST',
            message: err.message,
          });
        }
        throw err;
      }
    }),
});
