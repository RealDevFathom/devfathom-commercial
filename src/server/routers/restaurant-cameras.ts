import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { hasModule } from '@/lib/entitlements';
import { listActiveCameraBrandPresets } from '@/lib/restaurant/camera-presets';
import {
  enrollCameraGateway,
  gatewayHealth,
  revokeCameraGateway,
  rotateCameraGatewaySecret,
} from '@/lib/restaurant/cameras';
import {
  cameraGatewayRuntime,
  cameraGatewayPublicState,
} from '@/lib/restaurant/camera-gateway-runtime';
import { sealCameraCredential } from '@/lib/restaurant/camera-credentials';
import {
  CoAuthorizationError,
  buildCoAuthorizationRecord,
} from '@/lib/restaurant/co-authorization';
import { authenticateOperator } from '@/lib/restaurant/terminal-auth';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '../audit';
import { adminProcedure, router } from '../trpc';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const branchId = z.string().min(1);
function entitled(ctx: { entitlements: Parameters<typeof hasModule>[0] }) {
  if (!hasModule(ctx.entitlements, 'restaurant-integrations')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Camera integrations are not enabled.' });
  }
}

function requireCameraGateway() {
  if (!cameraGatewayRuntime.available) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Camera gateway service is not configured.',
    });
  }
  return cameraGatewayRuntime.adapter;
}

async function requireBranch(db: ScopedDb, id: string) {
  const branch = await db.restaurantBranch.findFirst({ where: { id }, select: { id: true } });
  if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
  return branch;
}

export const restaurantCamerasRouter = router({
  availability: adminProcedure.query(({ ctx }) => {
    entitled(ctx);
    return cameraGatewayPublicState(cameraGatewayRuntime);
  }),
  presets: adminProcedure.query(async ({ ctx }) => {
    entitled(ctx);
    return listActiveCameraBrandPresets();
  }),
  list: adminProcedure.query(async ({ ctx }) => {
    entitled(ctx);
    return ctx.db.restaurantCamera.findMany({ orderBy: { createdAt: 'desc' } });
  }),
  listGateways: adminProcedure.query(async ({ ctx }) => {
    entitled(ctx);
    const now = new Date();
    const rows = await ctx.db.restaurantCameraGateway.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      branchId: row.branchId,
      name: row.name,
      status: row.status,
      revokedAt: row.revokedAt,
      lastSeenAt: row.lastSeenAt,
      retentionDays: row.retentionDays,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      health: gatewayHealth(
        { ...row, status: row.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE' },
        now
      ),
    }));
  }),
  enrollGateway: adminProcedure
    .input(
      strict({
        branchId,
        name: z.string().trim().min(1).max(120),
        baseUrl: z.url(),
        retentionDays: z.number().int().min(1).max(90),
      })
    )
    .mutation(async ({ ctx, input }) => {
      entitled(ctx);
      await requireBranch(ctx.db, input.branchId);
      const result = await enrollCameraGateway(ctx.db, {
        ...input,
        organizationId: ctx.session.user.organizationId,
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantCameraGateway',
        targetId: String(result.gateway.id),
        description: 'Enrolled camera gateway',
        metadata: { branchId: input.branchId },
      });
      return {
        gateway: {
          id: result.gateway.id,
          name: result.gateway.name,
          branchId: result.gateway.branchId,
          status: result.gateway.status,
        },
        enrollmentSecret: result.secret,
      };
    }),
  rotateGatewaySecret: adminProcedure
    .input(strict({ gatewayId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      entitled(ctx);
      const found = await ctx.db.restaurantCameraGateway.findUnique({
        where: { id: input.gatewayId },
        select: { id: true },
      });
      if (!found) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gateway not found.' });
      const result = await rotateCameraGatewaySecret(ctx.db, found.id);
      return { gateway: { id: result.gateway.id }, enrollmentSecret: result.secret };
    }),
  revokeGateway: adminProcedure
    .input(
      strict({
        gatewayId: z.string().min(1),
        actingStaffProfileId: z.string().min(1),
        approvingStaffProfileId: z.string().min(1),
        approvingType: z.enum(['PIN', 'BADGE']),
        approvingSecret: z.string().min(1),
        reason: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      entitled(ctx);
      annotateAudit(ctx, { skipInput: true });
      const gateway = await ctx.db.restaurantCameraGateway.findUnique({
        where: { id: input.gatewayId },
      });
      if (!gateway) throw new TRPCError({ code: 'NOT_FOUND', message: 'Gateway not found.' });
      let record;
      try {
        record = buildCoAuthorizationRecord({
          actingStaffProfileId: input.actingStaffProfileId,
          approvingStaffProfileId: input.approvingStaffProfileId,
          capability: 'cameras:gateway:revoke',
          reason: input.reason,
          targetType: 'RestaurantCameraGateway',
          targetId: gateway.id,
        });
      } catch (error) {
        if (error instanceof CoAuthorizationError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        throw error;
      }
      const auth = await authenticateOperator(ctx.db, {
        staffProfileId: input.approvingStaffProfileId,
        type: input.approvingType,
        secret: input.approvingSecret,
        now: new Date(),
      });
      if (!auth.ok)
        throw new TRPCError({
          code: auth.reason === 'LOCKED' ? 'TOO_MANY_REQUESTS' : 'FORBIDDEN',
          message:
            auth.reason === 'LOCKED'
              ? 'Approving manager credential is temporarily locked.'
              : 'Invalid approving credential.',
        });
      const coAuthorization = await ctx.db.restaurantCoAuthorization.create({ data: record });
      const revoked = await revokeCameraGateway(ctx.db, gateway.id, new Date());
      return {
        gateway: { id: revoked.id, status: revoked.status },
        coAuthorizationId: coAuthorization.id,
      };
    }),
  getRetentionState: adminProcedure.input(strict({ branchId })).query(async ({ ctx, input }) => {
    entitled(ctx);
    await requireBranch(ctx.db, input.branchId);
    const gateway = await ctx.db.restaurantCameraGateway.findFirst({
      where: { branchId: input.branchId, status: 'ACTIVE' },
      select: { retentionDays: true },
    });
    const state = await requireCameraGateway().getRetentionState();
    return { days: gateway?.retentionDays ?? state.days, usedBytes: state.usedBytes };
  }),
  setRetention: adminProcedure
    .input(strict({ branchId, days: z.number().int().min(1).max(90) }))
    .mutation(async ({ ctx, input }) => {
      entitled(ctx);
      await requireBranch(ctx.db, input.branchId);
      await ctx.db.restaurantCameraGateway.updateMany({
        where: { branchId: input.branchId, status: 'ACTIVE' },
        data: { retentionDays: input.days },
      });
      return { days: input.days };
    }),
  listRecordings: adminProcedure
    .input(strict({ cameraId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      entitled(ctx);
      return requireCameraGateway().listRecordings(input.cameraId);
    }),
  issueStreamGrant: adminProcedure
    .input(strict({ cameraId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      entitled(ctx);
      requireCameraGateway();
      const camera = await ctx.db.restaurantCamera.findUnique({ where: { id: input.cameraId } });
      if (!camera) throw new TRPCError({ code: 'NOT_FOUND', message: 'Camera not found.' });
      const grant = await ctx.db.restaurantCameraStreamGrant.create({
        data: {
          cameraId: camera.id,
          viewerId: ctx.session.user.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      return { grantId: grant.id, expiresAt: grant.expiresAt };
    }),
  testConnection: adminProcedure
    .input(
      strict({
        outcome: z.enum(['ok', 'auth-failed', 'unreachable']).optional(),
        password: z.string().min(1),
        username: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      entitled(ctx);
      return requireCameraGateway().testConnection({ outcome: input.outcome });
    }),
  register: adminProcedure
    .input(
      strict({
        branchId,
        gatewayId: z.string().min(1),
        name: z.string().min(1).max(120),
        sourceRef: z.string().min(1).max(500),
        username: z.string().min(1),
        password: z.string().min(1),
        registerAnyway: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      entitled(ctx);
      await requireBranch(ctx.db, input.branchId);
      const key = process.env.CAMERA_CREDENTIAL_KEY;
      if (!key) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Camera credential storage is not configured.',
        });
      }
      const credential = await ctx.db.restaurantCameraCredential.create({
        data: {
          sealedValue: sealCameraCredential(
            JSON.stringify({ username: input.username, password: input.password }),
            key
          ),
        },
      });
      const camera = await ctx.db.restaurantCamera.create({
        data: {
          branchId: input.branchId,
          gatewayId: input.gatewayId,
          credentialId: credential.id,
          name: input.name,
          sourceRef: input.sourceRef,
          enabled: !input.registerAnyway,
        },
      });
      return { id: camera.id, name: camera.name, enabled: camera.enabled };
    }),
});
