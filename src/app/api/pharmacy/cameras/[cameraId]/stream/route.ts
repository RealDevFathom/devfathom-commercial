import { can, subjectFromSession } from '@/lib/abac';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { cameraGatewayRuntime } from '@/lib/cameras/camera-gateway-runtime';
import { CameraTransportError, rewriteCameraManifest } from '@/lib/cameras/mediamtx';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { hasPharmacyCameraBranchAccess } from '@/lib/pharmacy/camera-access';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-740 pharmacy live view. The browser only ever sees this same-origin URL
 * with an opaque short-lived grant; the gateway URL, private address, HLS reader
 * credentials and DVR credentials stay on the server. Every manifest and media
 * request re-authorizes actor, tenant, vertical, entitlement, capability,
 * branch, grant, camera and gateway before the scoped transport is read.
 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function response(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function GET(request: Request, context: { params: Promise<{ cameraId: string }> }) {
  let actor;
  try {
    actor = await resolveTenantActor({ request });
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    throw error;
  }
  const user = actor?.session.user;
  if (!actor || !user?.id) return response('Unauthorized', 401);
  if (actor.organization.isDemo) return response('Not available in demo.', 403);
  // Live tenant video is not part of platform support access.
  if (actor.support) return response('Forbidden', 403);
  if (actor.organization.vertical !== 'PHARMACY') return response('Forbidden', 403);
  const organizationId = actor.organization.id;
  if (user.organizationId !== organizationId) return response('Forbidden', 403);
  if (!cameraGatewayRuntime.available || cameraGatewayRuntime.mode !== 'mediamtx')
    return response('Live camera gateway unavailable', 503);

  const { cameraId } = await context.params;
  const requestUrl = new URL(request.url);
  const grantId = requestUrl.searchParams.get('grant');
  if (!grantId || !ID.test(grantId)) return response('Unauthorized', 401);
  if (!ID.test(cameraId)) return response('Forbidden', 403);
  if (requestUrl.searchParams.has('recording'))
    return response('Recording playback unsupported', 400);
  const resource = requestUrl.searchParams.get('segment') ?? 'index.m3u8';

  const grantIsLive = (
    grant: {
      organizationId: string;
      cameraId: string;
      viewerId: string;
      revokedAt: Date | null;
      expiresAt: Date;
    } | null
  ) =>
    Boolean(
      grant &&
      grant.organizationId === organizationId &&
      grant.viewerId === user.id &&
      grant.cameraId === cameraId &&
      !grant.revokedAt &&
      grant.expiresAt > new Date()
    );

  const state = await withTenantDb(organizationId, async (db) => {
    const entitlements = await resolveOrganizationEntitlements(organizationId, db);
    if (!hasModule(entitlements, 'pharmacy-core')) return { status: 403 as const };
    // Same capability as the camera console; a demoted owner loses the stream
    // on the next request instead of at grant expiry.
    if (!(await can(subjectFromSession(user), 'admin:access', undefined, { db })))
      return { status: 403 as const };
    const grant = await db.cameraStreamGrant.findFirst({
      where: { id: grantId, organizationId, viewerId: user.id },
    });
    if (!grant) return { status: 401 as const };
    if (grant.cameraId !== cameraId) return { status: 403 as const };
    if (!grantIsLive(grant)) return { status: 401 as const };
    const camera = await db.camera.findFirst({
      where: { id: cameraId, organizationId },
      include: { gateway: true },
    });
    if (
      !camera ||
      !camera.enabled ||
      camera.organizationId !== organizationId ||
      camera.gateway.organizationId !== organizationId ||
      camera.gateway.branchId !== camera.branchId ||
      camera.gateway.status !== 'ACTIVE' ||
      camera.gateway.revokedAt
    )
      return { status: 403 as const };
    if (
      !(await hasPharmacyCameraBranchAccess(db, {
        organizationId,
        branchId: camera.branchId,
        user: { id: user.id, role: user.role, organizationId: user.organizationId },
      }))
    )
      return { status: 403 as const };
    return { status: 200 as const, camera };
  });
  if (state.status !== 200)
    return response(state.status === 401 ? 'Unauthorized' : 'Forbidden', state.status);

  try {
    const result = await cameraGatewayRuntime.transport.read(
      {
        vertical: 'pharmacy',
        organizationId,
        branchId: state.camera.branchId,
        gatewayId: state.camera.gateway.id,
        cameraId,
        baseUrl: state.camera.gateway.baseUrl,
      },
      resource
    );
    // Revocation or expiry during a slow upstream read stops delivery here.
    const after = await withTenantDb(organizationId, (db) =>
      db.cameraStreamGrant.findFirst({ where: { id: grantId, organizationId, viewerId: user.id } })
    );
    if (!grantIsLive(after)) return response('Unauthorized', 401);
    const prefix = `/api/pharmacy/cameras/${encodeURIComponent(cameraId)}/stream?grant=${encodeURIComponent(grantId)}&segment=`;
    const body = result.manifest
      ? rewriteCameraManifest(
          result.bytes.toString('utf8'),
          (name) => `${prefix}${encodeURIComponent(name)}`
        )
      : new Uint8Array(result.bytes);
    return new Response(body, {
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (error) {
    // Fixed failure codes only: never an upstream body, URL, address or credential.
    if (error instanceof CameraTransportError) return response(error.code, 502);
    return response('gateway-unreachable', 502);
  }
}
