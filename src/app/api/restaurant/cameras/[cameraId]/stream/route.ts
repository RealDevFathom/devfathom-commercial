import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { cameraGatewayRuntime } from '@/lib/restaurant/camera-gateway-runtime';
import { withApiRoute } from '@/lib/api-route';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { CameraTransportError, rewriteCameraManifest } from '@/lib/restaurant/cameras/mediamtx';

function response(message: string, status: number) {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function handleGET(request: Request, context: { params: Promise<{ cameraId: string }> }) {
  const actor = await resolveTenantActor({ request });
  if (!actor?.session.user?.id) return response('Unauthorized', 401);
  if (actor.organization.isDemo) return response('Not available in demo.', 403);
  const organizationId = actor.organization.id;
  const entitlements = await withTenantDb(organizationId, (db) =>
    resolveOrganizationEntitlements(organizationId, db)
  );
  if (!hasModule(entitlements, 'restaurant-integrations')) return response('Forbidden', 403);
  if (!cameraGatewayRuntime.available) return response('Camera gateway unavailable', 503);
  const { cameraId } = await context.params;
  const requestUrl = new URL(request.url);
  if (requestUrl.searchParams.has('recording'))
    return response('Recording playback unsupported', 400);
  const grantId = requestUrl.searchParams.get('grant');
  if (!grantId) return response('Unauthorized', 401);

  const state = await withTenantDb(organizationId, async (db) => {
    const grant = await db.restaurantCameraStreamGrant.findUnique({ where: { id: grantId } });
    if (
      !grant ||
      grant.organizationId !== organizationId ||
      grant.expiresAt <= new Date() ||
      grant.revokedAt ||
      grant.viewerId !== actor.session.user.id
    )
      return { status: 401 as const };
    if (grant.cameraId !== cameraId) return { status: 403 as const };
    const camera = await db.restaurantCamera.findUnique({ where: { id: cameraId } });
    if (!camera || !camera.enabled || camera.organizationId !== organizationId)
      return { status: 403 as const };
    const gateway = await db.restaurantCameraGateway.findUnique({
      where: { id: camera.gatewayId },
    });
    if (
      !gateway ||
      gateway.organizationId !== organizationId ||
      gateway.branchId !== camera.branchId ||
      gateway.status !== 'ACTIVE' ||
      gateway.revokedAt
    )
      return { status: 403 as const };
    return { status: 200 as const, gateway, camera, expiresAt: grant.expiresAt };
  });
  if (state.status !== 200)
    return response(state.status === 401 ? 'Unauthorized' : 'Forbidden', state.status);

  if (cameraGatewayRuntime.mode !== 'mediamtx') return response('Camera gateway unavailable', 503);
  try {
    const resource = await cameraGatewayRuntime.transport.read(
      {
        organizationId,
        branchId: state.camera.branchId,
        gatewayId: state.gateway.id,
        cameraId,
        baseUrl: state.gateway.baseUrl,
      },
      requestUrl.searchParams.get('segment') ?? 'index.m3u8'
    );
    if (state.expiresAt <= new Date()) return response('Unauthorized', 401);
    const prefix = `/api/restaurant/cameras/${encodeURIComponent(cameraId)}/stream?grant=${encodeURIComponent(grantId)}&segment=`;
    const body = resource.manifest
      ? rewriteCameraManifest(
          resource.bytes.toString('utf8'),
          (name) => `${prefix}${encodeURIComponent(name)}`
        )
      : new Uint8Array(resource.bytes);
    return new Response(body, {
      headers: {
        'Content-Type': resource.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof CameraTransportError) return response(error.code, 502);
    return response('Gateway unavailable', 502);
  }
}

export const GET = withApiRoute(handleGET);
