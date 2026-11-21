import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { hasModule } from '@/lib/entitlements';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';
import { adminProcedure, router, type TRPCContext } from '@/server/trpc';

/**
 * CAM-3 camera privacy settings, one contract for both verticals. Pharmacy
 * reads the CAM-2 vertical-neutral tables; restaurant keeps reading its own
 * restaurant_camera_* tables, exactly as its camera console does.
 */
export type CameraPrivacyVertical = 'pharmacy' | 'restaurant';

export const CAMERA_RETENTION_DAYS = { min: 1, max: 90 } as const;

const MODULE: Record<CameraPrivacyVertical, string> = {
  pharmacy: 'pharmacy-core',
  restaurant: 'restaurant-integrations',
};

export type CameraPrivacyGateway = {
  id: string;
  name: string;
  retentionDays: number;
};

export type CameraPrivacyGrant = {
  id: string;
  cameraName: string;
  viewerName: string;
  createdAt: string;
  expiresAt: string;
  /** Neither revoked nor expired: the only grants that can be revoked. */
  active: boolean;
};

export type CameraPrivacyView = {
  gateways: CameraPrivacyGateway[];
  grants: CameraPrivacyGrant[];
};

const GRANT_HISTORY = 50;

type GrantRow = {
  id: string;
  cameraId: string;
  viewerId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

async function grantViews(
  db: ScopedDb,
  rows: GrantRow[],
  cameraNames: Map<string, string>,
  now: Date
): Promise<CameraPrivacyGrant[]> {
  const viewers = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.viewerId))] } },
    select: { id: true, name: true },
  });
  const viewerNames = new Map(viewers.map((viewer) => [viewer.id, viewer.name]));
  return rows.map((row) => ({
    id: row.id,
    cameraName: cameraNames.get(row.cameraId) ?? 'Removed camera',
    viewerName: viewerNames.get(row.viewerId) ?? 'Unknown viewer',
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    active: row.revokedAt === null && row.expiresAt > now,
  }));
}

export async function loadCameraPrivacy(
  db: ScopedDb,
  vertical: CameraPrivacyVertical,
  organizationId: string,
  now: Date
): Promise<CameraPrivacyView> {
  const where = { organizationId };
  const order = { orderBy: { createdAt: 'desc' as const } };
  if (vertical === 'pharmacy') {
    const [gateways, cameras, grants] = await Promise.all([
      db.cameraGateway.findMany({ where: { ...where, status: 'ACTIVE' }, ...order }),
      db.camera.findMany({ where, select: { id: true, name: true } }),
      db.cameraStreamGrant.findMany({ where, ...order, take: GRANT_HISTORY }),
    ]);
    return {
      gateways: gateways.map(({ id, name, retentionDays }) => ({ id, name, retentionDays })),
      grants: await grantViews(db, grants, new Map(cameras.map((c) => [c.id, c.name])), now),
    };
  }
  const [gateways, cameras, grants] = await Promise.all([
    db.restaurantCameraGateway.findMany({ where: { ...where, status: 'ACTIVE' }, ...order }),
    db.restaurantCamera.findMany({ where, select: { id: true, name: true } }),
    db.restaurantCameraStreamGrant.findMany({ where, ...order, take: GRANT_HISTORY }),
  ]);
  return {
    gateways: gateways.map(({ id, name, retentionDays }) => ({ id, name, retentionDays })),
    grants: await grantViews(db, grants, new Map(cameras.map((c) => [c.id, c.name])), now),
  };
}

/** Returns false when no active gateway of this organization has that id. */
export async function setCameraRetention(
  db: ScopedDb,
  vertical: CameraPrivacyVertical,
  organizationId: string,
  input: { gatewayId: string; days: number }
): Promise<boolean> {
  const args = {
    where: { id: input.gatewayId, organizationId, status: 'ACTIVE' },
    data: { retentionDays: input.days },
  };
  const updated =
    vertical === 'pharmacy'
      ? await db.cameraGateway.updateMany(args)
      : await db.restaurantCameraGateway.updateMany(args);
  return updated.count === 1;
}

/**
 * End a live-view grant now. Only an active grant is revoked; revoking twice or
 * revoking an expired grant is reported, never rewritten.
 */
export async function revokeCameraStreamGrant(
  db: ScopedDb,
  vertical: CameraPrivacyVertical,
  organizationId: string,
  grantId: string,
  now: Date
): Promise<boolean> {
  const args = {
    where: { id: grantId, organizationId, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
  };
  const updated =
    vertical === 'pharmacy'
      ? await db.cameraStreamGrant.updateMany(args)
      : await db.restaurantCameraStreamGrant.updateMany(args);
  return updated.count === 1;
}

const vertical = z.enum(['pharmacy', 'restaurant']);

function organizationFor(
  ctx: Pick<TRPCContext, 'support' | 'entitlements'>,
  input: { vertical: CameraPrivacyVertical }
): string {
  if (input.vertical === 'restaurant' && ctx.support) throw new TRPCError({ code: 'FORBIDDEN' });
  if (!hasModule(ctx.entitlements, MODULE[input.vertical])) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Camera settings are not enabled.' });
  }
  const organizationId = ctx.entitlements.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'No tenant.' });
  return organizationId;
}

/**
 * Called from the two settings pages through `createCaller`, like the pharmacy
 * consoles, so it is not mounted on the app router. Admin only and audited.
 */
export const cameraPrivacyRouter = router({
  view: adminProcedure
    .input(z.object({ vertical }).strict())
    .query(({ ctx, input }) =>
      loadCameraPrivacy(ctx.db, input.vertical, organizationFor(ctx, input), new Date())
    ),
  setRetention: adminProcedure
    .input(
      z
        .object({
          vertical,
          gatewayId: z.string().min(1),
          days: z.number().int().min(CAMERA_RETENTION_DAYS.min).max(CAMERA_RETENTION_DAYS.max),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = organizationFor(ctx, input);
      if (!(await setCameraRetention(ctx.db, input.vertical, organizationId, input))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Camera gateway not found.' });
      }
      return { days: input.days };
    }),
  revokeGrant: adminProcedure
    .input(z.object({ vertical, grantId: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      const organizationId = organizationFor(ctx, input);
      annotateAudit(ctx, {
        targetType:
          input.vertical === 'pharmacy' ? 'CameraStreamGrant' : 'RestaurantCameraStreamGrant',
        targetId: input.grantId,
        description: 'Revoked camera live-view grant',
      });
      const revoked = await revokeCameraStreamGrant(
        ctx.db,
        input.vertical,
        organizationId,
        input.grantId,
        new Date()
      );
      if (!revoked) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Live-view grant is no longer active.' });
      }
      return { revoked };
    }),
});
