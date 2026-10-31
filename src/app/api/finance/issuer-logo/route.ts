import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { loadRemoteImage } from '@/lib/remote-image';

const responseHeaders = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

/** Authenticated, same-origin delivery for the current tenant's externally hosted logo. */
export async function GET(request: Request) {
  const actor = await resolveTenantActor({ request });
  if (!actor?.session.user?.id) return new Response('Unauthorized', { status: 401 });

  const brand = await withTenantDb(actor.organization.id, (db) =>
    db.organizationBrand.findUnique({
      where: { organizationId: actor.organization.id },
      select: { logoUrl: true },
    })
  );
  if (!brand?.logoUrl) return new Response('Logo not found', { status: 404 });

  try {
    const image = await loadRemoteImage(brand.logoUrl);
    return new Response(new Uint8Array(image.body), {
      headers: { ...responseHeaders, 'Content-Type': image.contentType },
    });
  } catch {
    return new Response('Logo unavailable', { status: 502, headers: responseHeaders });
  }
}
