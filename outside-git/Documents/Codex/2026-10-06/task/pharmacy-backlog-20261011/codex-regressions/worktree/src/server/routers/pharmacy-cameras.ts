import { createHash, randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import { hasModule } from '@/lib/entitlements';
import { CAMERA_BRAND_PRESETS } from '@/lib/cameras/presets';
import {
  cameraGatewayRuntime,
  cameraGatewayPublicState,
} from '@/lib/cameras/camera-gateway-runtime';
import { setCameraPreset, CameraPresetError } from '@/lib/cameras/camera-preset';
import { captureCameraEvidence, evidenceSnapshotAdapter } from '@/lib/cameras/evidence';
import { stillDataUrl } from '@/lib/pharmacy/counter-evidence';
import { sealCameraCredential } from '@/lib/restaurant/camera-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '../audit';
import { adminProcedure, router } from '../trpc';

const id = z.string().min(1).max(128);
const refs = z.enum(['sim-camera-1', 'sim-counter-1', 'sim-fridge-1']);
const cameraProcedure = adminProcedure.use(({ ctx, next }) => {
  if (
    !hasModule(ctx.entitlements, 'pharmacy-core') ||
    !ctx.organization?.id ||
    ctx.organization.id !== ctx.session.user.organizationId ||
    ctx.entitlements.organizationId !== ctx.organization.id
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  return next({ ctx });
});
function simulated() {
  if (!cameraGatewayRuntime.available || cameraGatewayRuntime.mode !== 'simulated')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'Diagnostic simulator is unavailable. Physical gateway activation is not supported here.',
    });
  return cameraGatewayRuntime.adapter;
}
async function branch(db: ScopedDb, organizationId: string, branchId: string) {
  if (
    !(await db.pharmacyBranch.findFirst({
      where: { id: branchId, organizationId, active: true },
      select: { id: true },
    }))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch unavailable.' });
}
async function camera(db: ScopedDb, organizationId: string, cameraId: string) {
  const row = await db.camera.findFirst({
    where: { id: cameraId, organizationId },
    include: { gateway: true },
  });
  if (!row) throw new TRPCError({ code: 'NOT_FOUND' });
  await branch(db, organizationId, row.branchId);
  return row;
}
export const pharmacyCamerasRouter = router({
  workspace: cameraProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.session.user.organizationId;
    const [branches, gateways, cameras, zones] = await Promise.all([
      ctx.db.pharmacyBranch.findMany({
        where: { organizationId, active: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      ctx.db.cameraGateway.findMany({
        where: { organizationId },
        select: { id: true, name: true, branchId: true, status: true, retentionDays: true },
        orderBy: { createdAt: 'asc' },
      }),
      ctx.db.camera.findMany({
        where: { organizationId },
        select: {
          id: true,
          name: true,
          branchId: true,
          gatewayId: true,
          sourceRef: true,
          enabled: true,
          preset: true,
          temperatureZoneId: true,
          counterEvidence: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      ctx.db.pharmacyStockLocation.findMany({
        where: { organizationId, active: true, coldChain: true },
        select: { id: true, name: true, branchId: true },
      }),
    ]);
    return {
      branches,
      gateways,
      cameras,
      zones,
      presets: CAMERA_BRAND_PRESETS,
      availability: cameraGatewayPublicState(cameraGatewayRuntime),
    };
  }),
  enrollGateway: cameraProcedure
    .input(
      z
        .object({
          branchId: id,
          name: z.string().trim().min(1).max(120),
          retentionDays: z.number().int().min(1).max(90),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      simulated();
      const organizationId = ctx.session.user.organizationId;
      await branch(ctx.db, organizationId, input.branchId);
      await ctx.db.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${`camera-gateway:${input.branchId}:${input.name}`}))`
      );
      const prior = await ctx.db.cameraGateway.findFirst({
        where: {
          organizationId,
          branchId: input.branchId,
          name: input.name,
          status: 'ACTIVE',
          revokedAt: null,
        },
        select: { id: true },
      });
      if (prior) return prior;
      const gateway = await ctx.db.cameraGateway.create({
        data: {
          ...input,
          organizationId,
          baseUrl: 'http://127.0.0.1',
          gatewaySecretHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        },
        select: { id: true },
      });
      annotateAudit(ctx, {
        targetType: 'CameraGateway',
        targetId: gateway.id,
        description: 'Registered diagnostic pharmacy gateway; no hardware connection',
      });
      return gateway;
    }),
  testConnection: cameraProcedure
    .input(z.object({ branchId: id, sourceRef: refs }).strict())
    .mutation(async ({ ctx, input }) => {
      await branch(ctx.db, ctx.session.user.organizationId, input.branchId);
      await simulated().getSnapshot(input.sourceRef);
      return {
        outcome: 'ok' as const,
        discoveredProfile: 'Diagnostic simulator only; no hardware or live video',
      };
    }),
  register: cameraProcedure
    .input(
      z
        .object({
          branchId: id,
          gatewayId: id,
          name: z.string().trim().min(1).max(120),
          sourceRef: refs,
          username: z.string().min(1).max(200),
          password: z.string().min(1).max(500),
          registerAnyway: z.boolean().default(false),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      simulated();
      annotateAudit(ctx, { skipInput: true });
      const organizationId = ctx.session.user.organizationId;
      await branch(ctx.db, organizationId, input.branchId);
      const gateway = await ctx.db.cameraGateway.findFirst({
        where: {
          organizationId,
          id: input.gatewayId,
          branchId: input.branchId,
          status: 'ACTIVE',
          revokedAt: null,
        },
      });
      if (!gateway)
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Gateway unavailable in branch.' });
      const key = process.env.CAMERA_CREDENTIAL_KEY;
      if (!key)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Private credential storage unavailable.',
        });
      await ctx.db.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${`camera:${input.gatewayId}:${input.sourceRef}`}))`
      );
      const prior = await ctx.db.camera.findFirst({
        where: { organizationId, gatewayId: input.gatewayId, sourceRef: input.sourceRef },
        select: { id: true },
      });
      if (prior) return prior;
      const credential = await ctx.db.cameraCredential.create({
        data: {
          organizationId,
          sealedValue: sealCameraCredential(
            JSON.stringify({ username: input.username, password: input.password }),
            key
          ),
        },
      });
      const saved = await ctx.db.camera.create({
        data: {
          organizationId,
          branchId: input.branchId,
          gatewayId: gateway.id,
          credentialId: credential.id,
          name: input.name,
          sourceRef: input.sourceRef,
          enabled: !input.registerAnyway,
        },
        select: { id: true },
      });
      annotateAudit(ctx, {
        targetType: 'Camera',
        targetId: saved.id,
        description: 'Registered diagnostic pharmacy camera',
      });
      return saved;
    }),
  configure: cameraProcedure
    .input(
      z
        .object({
          cameraId: id,
          preset: z.enum(['COUNTER', 'COLD_CHAIN']).nullable(),
          temperatureZoneId: id.nullable().optional(),
          enabled: z.boolean(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.session.user.organizationId;
      const row = await camera(ctx.db, organizationId, input.cameraId);
      try {
        // setCameraPreset sets counterEvidence exactly when the preset is COUNTER.
        await setCameraPreset(ctx.db, { organizationId, branchId: row.branchId }, input);
      } catch (error) {
        if (error instanceof CameraPresetError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.reason });
        throw error;
      }
      annotateAudit(ctx, {
        targetType: 'Camera',
        targetId: row.id,
        description: `Configured pharmacy camera preset ${input.preset ?? 'none'}; ${input.enabled ? 'enabled' : 'disabled'}`,
      });
      return ctx.db.camera.update({
        where: { id: row.id },
        data: { enabled: input.enabled },
        select: { id: true },
      });
    }),
  setRetention: cameraProcedure
    .input(z.object({ branchId: id, days: z.number().int().min(1).max(90) }).strict())
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.session.user.organizationId;
      await branch(ctx.db, organizationId, input.branchId);
      // The existing retention job reads gateway.retentionDays; nothing else changes here.
      const updated = await ctx.db.cameraGateway.updateMany({
        where: { organizationId, branchId: input.branchId, status: 'ACTIVE', revokedAt: null },
        data: { retentionDays: input.days },
      });
      annotateAudit(ctx, {
        targetType: 'PharmacyBranch',
        targetId: input.branchId,
        description: `Set camera evidence retention to ${input.days} days`,
      });
      return { days: input.days, gateways: updated.count };
    }),
  issueViewerGrant: cameraProcedure
    .input(z.object({ cameraId: id, previousGrantId: id.optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      const row = await camera(ctx.db, ctx.session.user.organizationId, input.cameraId);
      if (!row.enabled || row.gateway.status !== 'ACTIVE' || row.gateway.revokedAt)
        throw new TRPCError({ code: 'FORBIDDEN' });
      if (input.previousGrantId) {
        // Renewal only extends a live grant this viewer already holds for this camera.
        const previous = await ctx.db.cameraStreamGrant.findFirst({
          where: {
            id: input.previousGrantId,
            organizationId: row.organizationId,
            cameraId: row.id,
            viewerId: ctx.session.user.id,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (!previous)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Viewer access expired or was revoked.',
          });
      }
      return ctx.db.cameraStreamGrant.create({
        data: {
          organizationId: row.organizationId,
          cameraId: row.id,
          viewerId: ctx.session.user.id,
          expiresAt: new Date(Date.now() + 60000),
        },
        select: { id: true, expiresAt: true },
      });
    }),
  revokeViewerGrant: cameraProcedure
    .input(z.object({ cameraId: id, grantId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      const organizationId = ctx.session.user.organizationId;
      // Revocation is the viewer's own close; it never touches another viewer's grant.
      const revoked = await ctx.db.cameraStreamGrant.updateMany({
        where: {
          id: input.grantId,
          organizationId,
          cameraId: input.cameraId,
          viewerId: ctx.session.user.id,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      return { revoked: revoked.count };
    }),
  evidence: cameraProcedure
    .input(z.object({ cameraId: id, grantId: id }).strict())
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.session.user.organizationId;
      const row = await camera(ctx.db, organizationId, input.cameraId);
      if (!row.enabled || row.gateway.status !== 'ACTIVE' || row.gateway.revokedAt)
        throw new TRPCError({ code: 'FORBIDDEN' });
      const grant = await ctx.db.cameraStreamGrant.findFirst({
        where: {
          id: input.grantId,
          organizationId,
          cameraId: row.id,
          viewerId: ctx.session.user.id,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!grant)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Viewer access expired or was revoked.',
        });
      const evidence = await ctx.db.cameraEvidence.findMany({
        where: { organizationId, branchId: row.branchId, cameraId: row.id },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        take: 10,
      });
      return Promise.all(
        evidence.map(async (e) => ({
          id: e.id,
          subjectKind: e.subjectKind,
          subjectId: e.subjectId,
          status: e.status,
          requestedAt: e.requestedAt,
          capturedAt: e.capturedAt,
          failureReason: e.failureReason,
          image:
            e.status === 'CAPTURED' && e.storageKey
              ? await stillDataUrl(organizationId, e.storageKey)
              : null,
        }))
      );
    }),
  capturePending: cameraProcedure
    .input(z.object({ cameraId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      simulated();
      const row = await camera(ctx.db, ctx.session.user.organizationId, input.cameraId);
      const pending = await ctx.db.cameraEvidence.findMany({
        where: {
          organizationId: row.organizationId,
          branchId: row.branchId,
          cameraId: row.id,
          status: 'PENDING',
        },
        select: { id: true },
        take: 10,
        orderBy: { requestedAt: 'asc' },
      });
      for (const e of pending)
        await captureCameraEvidence(ctx.db, {
          organizationId: row.organizationId,
          evidenceId: e.id,
          adapter: evidenceSnapshotAdapter(cameraGatewayRuntime),
          now: new Date(),
          finalAttempt: true,
        });
      return { processed: pending.length };
    }),
});
