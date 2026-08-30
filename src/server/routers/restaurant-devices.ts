import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  CoAuthorizationError,
  buildCoAuthorizationRecord,
} from '@/lib/restaurant/co-authorization';
import { deviceHealth, enrollDevice, revokeDevice } from '@/lib/restaurant/devices';
import { staffHasCapability } from '@/lib/restaurant/job-roles';
import { authenticateOperator } from '@/lib/restaurant/terminal-auth';
import { annotateAudit } from '../audit';
import { capabilityProcedure, router } from '../trpc';

const manageDevicesProcedure = capabilityProcedure('devices:manage');

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
  /** List registered devices with derived operational health (no secret material). */
  list: manageDevicesProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const devices = await ctx.db.restaurantRegisteredDevice.findMany({
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
    }));
  }),

  /** Enroll a device to a branch; returns the one-time enrollment secret. */
  initiateEnrollment: manageDevicesProcedure
    .input(
      z.object({
        branchId: z.string().min(1),
        name: z.string().min(1).max(120),
        kind: z.enum(['POS', 'KDS']).optional(),
        stationId: z.string().min(1).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const branch = await ctx.db.restaurantBranch.findUnique({
        where: { id: input.branchId },
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

      const { device, secret } = await enrollDevice(ctx.db, {
        branchId: input.branchId,
        name: input.name,
        kind,
        stationId: kind === 'KDS' ? input.stationId : null,
      });

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
    .input(
      z.object({
        deviceId: z.string().min(1),
        actingStaffProfileId: z.string().min(1),
        approvingStaffProfileId: z.string().min(1),
        approvingType: z.enum(['PIN', 'BADGE']),
        approvingSecret: z.string().min(1),
        reason: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });

      const device = await ctx.db.restaurantRegisteredDevice.findUnique({
        where: { id: input.deviceId },
      });
      if (!device) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found.' });
      }
      if (device.status === 'REVOKED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Device is already revoked.' });
      }

      // Both identities must exist and be ACTIVE in this organization.
      const [acting, approving] = await Promise.all([
        ctx.db.restaurantStaffProfile.findUnique({
          where: { id: input.actingStaffProfileId },
          select: { id: true, status: true },
        }),
        ctx.db.restaurantStaffProfile.findUnique({
          where: { id: input.approvingStaffProfileId },
          select: { id: true, status: true },
        }),
      ]);
      if (!acting || acting.status !== 'ACTIVE') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Acting staff profile is not active.',
        });
      }
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
          actingStaffProfileId: input.actingStaffProfileId,
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

      const now = new Date();
      const auth = await authenticateOperator(ctx.db, {
        staffProfileId: input.approvingStaffProfileId,
        type: input.approvingType,
        secret: input.approvingSecret,
        now,
      });
      if (!auth.ok) {
        if (auth.reason === 'LOCKED') {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Approving manager credential is temporarily locked.',
          });
        }
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid approving credential.' });
      }
      if (
        !(await staffHasCapability(
          ctx.db,
          input.approvingStaffProfileId,
          device.branchId,
          'devices:manage'
        ))
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'The approving manager lacks device-management permission.',
        });
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
          actingStaffProfileId: input.actingStaffProfileId,
          approvingStaffProfileId: input.approvingStaffProfileId,
        },
      });

      return {
        device: { id: revoked.id, status: revoked.status },
        coAuthorizationId: coAuthorization.id,
      };
    }),
});
