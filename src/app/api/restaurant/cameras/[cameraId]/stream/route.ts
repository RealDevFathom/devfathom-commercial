import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { cameraGatewayRuntime } from '@/lib/restaurant/camera-gateway-runtime';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=@%-]+$/;

function response(message: string, status: number) {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function boundedFetch(url: URL, maximum: number) {
  const upstream = await fetch(url, { redirect: 'manual', cache: 'no-store' });
  if (upstream.status >= 300 && upstream.status < 400)
    throw new Error('Gateway redirects are refused.');
  if (!upstream.ok) throw new Error('Gateway request failed.');
  const declared = Number(upstream.headers.get('content-length') ?? 0);
  if (declared > maximum) throw new Error('Gateway response is too large.');
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error('Gateway response is too large.');
  return bytes;
}

export async function GET(request: Request, context: { params: Promise<{ cameraId: string }> }) {
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
  const grantId = requestUrl.searchParams.get('grant');
  if (!grantId) return response('Unauthorized', 401);

  const state = await withTenantDb(organizationId, async (db) => {
    const grant = await db.restaurantCameraStreamGrant.findUnique({ where: { id: grantId } });
    if (
      !grant ||
      grant.expiresAt <= new Date() ||
      grant.revokedAt ||
      grant.viewerId !== actor.session.user.id
    )
      return { status: 401 as const };
    if (grant.cameraId !== cameraId) return { status: 403 as const };
    const camera = await db.restaurantCamera.findUnique({ where: { id: cameraId } });
    if (!camera || camera.organizationId !== organizationId) return { status: 403 as const };
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
    return { status: 200 as const, gateway };
  });
  if (state.status !== 200)
    return response(state.status === 401 ? 'Unauthorized' : 'Forbidden', state.status);

  const base = new URL(state.gateway.baseUrl);
  const segment = requestUrl.searchParams.get('segment');
  const upstream = segment
    ? new URL(
        `cameras/${encodeURIComponent(cameraId)}/live/${SAFE_SEGMENT.test(segment) ? segment : '__invalid__'}`,
        base
      )
    : new URL(`cameras/${encodeURIComponent(cameraId)}/live/index.m3u8`, base);
  if (upstream.origin !== base.origin || (segment && !SAFE_SEGMENT.test(segment)))
    return response('Bad request', 400);
  try {
    const bytes = await boundedFetch(upstream, segment ? MAX_SEGMENT_BYTES : MAX_MANIFEST_BYTES);
    if (segment)
      return new Response(bytes, {
        headers: { 'Content-Type': 'video/mp2t', 'Cache-Control': 'private, no-store' },
      });
    const text = new TextDecoder().decode(bytes);
    const prefix = `/api/restaurant/cameras/${encodeURIComponent(cameraId)}/stream?grant=${encodeURIComponent(grantId)}&segment=`;
    const rewritten = text
      .split('\n')
      .map((line) =>
        !line || line.startsWith('#')
          ? line
          : `${prefix}${encodeURIComponent(line.split('/').pop() ?? '')}`
      )
      .join('\n');
    return new Response(rewritten, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return response('Gateway unavailable', 502);
  }
}
