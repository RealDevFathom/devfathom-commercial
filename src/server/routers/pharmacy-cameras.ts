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
import { isCameraGatewayBaseUrl, isCameraGatewayPath } from '@/lib/cameras/mediamtx';
import { hasPharmacyCameraBranchAccess } from '@/lib/pharmacy/camera-access';
import {
  canReadCameraEvidence,
  captureCameraEvidence,
  evidenceSnapshotAdapter,
  evidenceSnapshotSupported,
} from '@/lib/cameras/evidence';
import { stillDataUrl } from '@/lib/pharmacy/counter-evidence';
import { sealCameraCredential } from '@/lib/restaurant/camera-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '../audit';
import { annotateAuditBranch } from '../audit-branch';
import { adminProcedure, router, type TRPCContext } from '../trpc';
import { refuseSupportSession } from '@/lib/tenancy/support-session-rule';

const id = z.string().min(1).max(128);
const refs = z.enum(['sim-camera-1', 'sim-counter-1', 'sim-fridge-1']);
/**
 * Live grant lifetime. The shared live session rejects a grant with more than
 * 60 s left by the browser's clock, so issue 55 s: a browser clock up to 5 s
 * behind the server still accepts it. The player renews 15 s before expiry.
 */
const LIVE_GRANT_MS = 55_000;
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
/**
 * DEV-740 live viewing through the owner-provisioned MediaMTX gateway. Pharmacy
 * tenants only, never a platform support session, and only in configured mode.
 */
const liveProcedure = cameraProcedure.use(({ ctx, next }) => {
  if (ctx.organization?.vertical !== 'PHARMACY' || ctx.support)
    throw new TRPCError({ code: 'FORBIDDEN' });
  return next({ ctx });
});
function configured() {
  if (!cameraGatewayRuntime.available || cameraGatewayRuntime.mode !== 'mediamtx')
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Live viewing requires a configured camera gateway.',
    });
  return cameraGatewayRuntime;
}
/** Which setup path the runtime supports; anything else fails closed. */
function setupMode(): 'simulated' | 'mediamtx' {
  if (cameraGatewayRuntime.available && cameraGatewayRuntime.mode === 'mediamtx') return 'mediamtx';
  simulated();
  return 'simulated';
}
async function liveBranch(ctx: TRPCContext, organizationId: string, branchId: string) {
  const user = ctx.session!.user;
  if (
    !(await hasPharmacyCameraBranchAccess(ctx.db, {
      organizationId,
      branchId,
      user: { id: user.id, role: user.role, organizationId: user.organizationId },
    }))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
}
/**
 * Configured (mediamtx) mode holds real production cameras, so every camera-bound
 * procedure there applies the live rule: pharmacy tenant, no platform support
 * session, and branch access. The simulator path keeps its existing rule.
 */
async function configuredModeGuard(ctx: TRPCContext, organizationId: string, branchId: string) {
  if (!cameraGatewayRuntime.available || cameraGatewayRuntime.mode !== 'mediamtx') return;
  if (ctx.organization?.vertical !== 'PHARMACY' || ctx.support)
    throw new TRPCError({ code: 'FORBIDDEN' });
  await liveBranch(ctx, organizationId, branchId);
}
/** Camera, gateway and branch must agree and be live; the stream route repeats this. */
function assertLiveGateway(row: Awaited<ReturnType<typeof camera>>) {
  if (
    row.gateway.status !== 'ACTIVE' ||
    row.gateway.revokedAt ||
    row.gateway.organizationId !== row.organizationId ||
    row.gateway.branchId !== row.branchId
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Camera gateway unavailable.' });
}
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
          // Read only to decide still support below; never returned to the browser.
          gateway: { select: { branchId: true, baseUrl: true } },
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
      cameras: cameras.map(({ gateway, ...camera }) => ({
        ...camera,
        // DEV-745: true only when this exact camera scope has a snapshot binding
        // (or the simulator is running). False is the honest unsupported state.
        evidenceStills: evidenceSnapshotSupported(cameraGatewayRuntime, {
          organizationId,
          branchId: camera.branchId,
          gatewayId: camera.gatewayId,
          gatewayBranchId: gateway.branchId,
          gatewayBaseUrl: gateway.baseUrl,
          cameraId: camera.id,
        }),
      })),
      zones,
      presets: CAMERA_BRAND_PRESETS,
      availability: cameraGatewayPublicState(cameraGatewayRuntime),
      /** Binding identifiers the gateway owner needs; no URL, address or secret. */
      organizationId,
    };
  }),
  enrollGateway: cameraProcedure
    .meta(refuseSupportSession)
    .input(
      z
        .object({
          branchId: id,
          name: z.string().trim().min(1).max(120),
          retentionDays: z.number().int().min(1).max(90),
          /** Configured mode only: exactly `https://hostname[:port]/`. */
          baseUrl: z.string().max(500).optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const mode = setupMode();
      const organizationId = ctx.session.user.organizationId;
      await branch(ctx.db, organizationId, input.branchId);
      if (mode === 'mediamtx') {
        if (ctx.organization?.vertical !== 'PHARMACY' || ctx.support)
          throw new TRPCError({ code: 'FORBIDDEN' });
        await liveBranch(ctx, organizationId, input.branchId);
        if (!input.baseUrl || !isCameraGatewayBaseUrl(input.baseUrl))
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Gateway URL must be exactly https://hostname/ (optional port); no address, path, sign-in details or query.',
          });
      } else if (input.baseUrl !== undefined) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Diagnostic simulator gateways do not take a URL.',
        });
      }
      const baseUrl = mode === 'mediamtx' ? input.baseUrl! : 'http://127.0.0.1';
      await ctx.db.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${`camera-gateway:${input.branchId}:${input.name}`}))`
      );
      // The simulator keeps its original lookup (its fixed URL), so it never
      // adopts a same-named configured gateway. Configured mode is idempotent by
      // name, matching the lock key, and refuses a same-named gateway that points
      // somewhere else instead of silently returning it.
      const prior = await ctx.db.cameraGateway.findFirst({
        where: {
          organizationId,
          branchId: input.branchId,
          name: input.name,
          ...(mode === 'simulated' ? { baseUrl } : {}),
          status: 'ACTIVE',
          revokedAt: null,
        },
        select: { id: true, baseUrl: true },
      });
      if (prior && mode === 'mediamtx' && prior.baseUrl !== baseUrl)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'An active gateway with this name already exists in this branch.',
        });
      if (prior) return { id: prior.id };
      const gateway = await ctx.db.cameraGateway.create({
        data: {
          branchId: input.branchId,
          name: input.name,
          retentionDays: input.retentionDays,
          organizationId,
          baseUrl,
          gatewaySecretHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        },
        select: { id: true },
      });
      annotateAudit(ctx, {
        targetType: 'CameraGateway',
        targetId: gateway.id,
        description:
          mode === 'mediamtx'
            ? 'Registered configured pharmacy camera gateway; no device connection made'
            : 'Registered diagnostic pharmacy gateway; no hardware connection',
      });
      return gateway;
    }),
  testConnection: cameraProcedure
    .input(z.object({ branchId: id, sourceRef: refs }).strict())
    .mutation(async ({ ctx, input }) => {
      await branch(ctx.db, ctx.session.user.organizationId, input.branchId);
      if (cameraGatewayRuntime.available && cameraGatewayRuntime.mode === 'mediamtx')
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Configured gateways are checked after registration. Run Check configured connection on the camera card.',
        });
      await simulated().getSnapshot(input.sourceRef);
      return {
        outcome: 'ok' as const,
        discoveredProfile: 'Diagnostic simulator only; no hardware or live video',
      };
    }),
  register: cameraProcedure
    .meta(refuseSupportSession)
    .input(
      z
        .object({
          branchId: id,
          gatewayId: id,
          name: z.string().trim().min(1).max(120),
          /** Simulator source, or in configured mode the gateway's stream path name. */
          sourceRef: z.string().min(1).max(120),
          /** Simulator placeholders only. Configured mode never accepts DVR credentials. */
          username: z.string().min(1).max(200).optional(),
          password: z.string().min(1).max(500).optional(),
          registerAnyway: z.boolean().default(false),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const mode = setupMode();
      annotateAudit(ctx, { skipInput: true });
      const organizationId = ctx.session.user.organizationId;
      await branch(ctx.db, organizationId, input.branchId);
      if (mode === 'mediamtx') {
        if (ctx.organization?.vertical !== 'PHARMACY' || ctx.support)
          throw new TRPCError({ code: 'FORBIDDEN' });
        await liveBranch(ctx, organizationId, input.branchId);
        if (input.username !== undefined || input.password !== undefined)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              "DVR credentials stay in the gateway owner's protected configuration. Do not enter them here.",
          });
        if (!isCameraGatewayPath(input.sourceRef))
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Stream path may use letters, numbers, dashes, underscores and slashes only.',
          });
      } else if (
        !refs.safeParse(input.sourceRef).success ||
        input.username === undefined ||
        input.password === undefined
      ) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose a simulator source.' });
      }
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
          // Configured mode stores a no-secret marker: the gateway owner holds the
          // DVR source credentials and the app holds only the HLS reader secret.
          sealedValue: sealCameraCredential(
            JSON.stringify(
              mode === 'mediamtx'
                ? { provisioning: 'gateway-owner' }
                : { username: input.username, password: input.password }
            ),
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
          // A configured camera starts disabled. Enabling it is the owner's call
          // (operator guidance: after the binding exists and the configured check
          // reports ok); the server does not record or enforce that check.
          enabled: mode === 'mediamtx' ? false : !input.registerAnyway,
        },
        select: { id: true },
      });
      annotateAudit(ctx, {
        targetType: 'Camera',
        targetId: saved.id,
        description:
          mode === 'mediamtx'
            ? 'Registered configured pharmacy camera (disabled until verified)'
            : 'Registered diagnostic pharmacy camera',
      });
      return saved;
    }),
  configure: cameraProcedure
    .meta(refuseSupportSession)
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
      annotateAuditBranch(ctx, row.branchId);
      // Configured mode: enabling a camera exposes live video, so apply the live
      // branch rule. The simulator path keeps its existing organization-wide rule.
      await configuredModeGuard(ctx, organizationId, row.branchId);
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
    .meta(refuseSupportSession)
    .input(z.object({ cameraId: id, previousGrantId: id.optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      const row = await camera(ctx.db, ctx.session.user.organizationId, input.cameraId);
      annotateAuditBranch(ctx, row.branchId);
      await configuredModeGuard(ctx, ctx.session.user.organizationId, row.branchId);
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
  /**
   * Registered-camera gateway check. A mutation so every outbound probe is
   * audited. `ok` proves only a readable supported manifest, not live frames,
   * codecs or DVR compatibility.
   */
  configuredConnectionDiagnostics: liveProcedure
    .input(z.object({ cameraId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.session.user.organizationId;
      const row = await camera(ctx.db, organizationId, input.cameraId);
      annotateAuditBranch(ctx, row.branchId);
      await liveBranch(ctx, organizationId, row.branchId);
      assertLiveGateway(row);
      if (!cameraGatewayRuntime.available || cameraGatewayRuntime.mode !== 'mediamtx')
        return { outcome: 'not-configured' as const };
      const result = await cameraGatewayRuntime.transport.diagnose({
        vertical: 'pharmacy',
        organizationId,
        branchId: row.branchId,
        gatewayId: row.gateway.id,
        cameraId: row.id,
        baseUrl: row.gateway.baseUrl,
      });
      annotateAudit(ctx, {
        targetType: 'Camera',
        targetId: row.id,
        description: 'Checked configured pharmacy camera gateway connection',
        metadata: { outcome: result.outcome },
      });
      // The codec lets the camera card say which browsers play H.265; nothing else
      // from the transport is returned.
      return result.outcome === 'ok' && 'videoCodec' in result
        ? { outcome: result.outcome, videoCodec: result.videoCodec }
        : { outcome: result.outcome };
    }),
  /**
   * Short-lived live-view grant. Renewal needs a live grant this viewer holds
   * for this camera; the prior grant then lapses within 15 s.
   */
  issueLiveViewGrant: liveProcedure
    .input(z.object({ cameraId: id, previousGrantId: id.optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      configured();
      const organizationId = ctx.session.user.organizationId;
      const row = await camera(ctx.db, organizationId, input.cameraId);
      annotateAuditBranch(ctx, row.branchId);
      await liveBranch(ctx, organizationId, row.branchId);
      if (!row.enabled) throw new TRPCError({ code: 'FORBIDDEN', message: 'Camera disabled.' });
      assertLiveGateway(row);
      const now = new Date();
      if (input.previousGrantId) {
        // Not revoked here: the player is still reading with it until the new
        // grant reaches the browser, and an early 401 would end the view. It
        // expires within 15 s; closing the view revokes the latest grant.
        const previous = await ctx.db.cameraStreamGrant.findFirst({
          where: {
            id: input.previousGrantId,
            organizationId,
            cameraId: row.id,
            viewerId: ctx.session.user.id,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true },
        });
        if (!previous)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Live view authorization ended. Open live view to request access.',
          });
      }
      const grant = await ctx.db.cameraStreamGrant.create({
        data: {
          organizationId,
          cameraId: row.id,
          viewerId: ctx.session.user.id,
          expiresAt: new Date(now.getTime() + LIVE_GRANT_MS),
        },
        select: { id: true, expiresAt: true },
      });
      annotateAudit(ctx, {
        targetType: 'Camera',
        targetId: row.id,
        description: input.previousGrantId
          ? 'Renewed pharmacy live camera view'
          : 'Opened pharmacy live camera view',
        metadata: { branchId: row.branchId },
      });
      return { grantId: grant.id, expiresAt: grant.expiresAt };
    }),
  revokeViewerGrant: cameraProcedure
    .meta(refuseSupportSession)
    .input(z.object({ cameraId: id, grantId: id }).strict())
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      const organizationId = ctx.session.user.organizationId;
      // The camera's branch, for the audit entry only: a missing camera still
      // revokes nothing, exactly as before.
      const cameraRow = await ctx.db.camera.findFirst({
        where: { id: input.cameraId, organizationId },
        select: { branchId: true },
      });
      annotateAuditBranch(ctx, cameraRow?.branchId);
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
      await configuredModeGuard(ctx, organizationId, row.branchId);
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
      const serverNow = new Date();
      return Promise.all(
        evidence.map(async (e) => ({
          id: e.id,
          subjectKind: e.subjectKind,
          subjectId: e.subjectId,
          status: e.status,
          requestedAt: e.requestedAt,
          capturedAt: e.capturedAt,
          failureReason: e.failureReason,
          image: canReadCameraEvidence(e, row.gateway.retentionDays, serverNow)
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
      annotateAuditBranch(ctx, row.branchId);
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
