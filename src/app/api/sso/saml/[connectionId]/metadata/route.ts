import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { publicRequestOrigin } from '@/lib/http-origin';
import { PrismaSamlCache, callbackUrl, requireIdentityConnection } from '@/lib/sso';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

export async function GET(request: Request, route: { params: Promise<{ connectionId: string }> }) {
  try {
    const { connectionId } = await route.params;
    const connection = await requireIdentityConnection(request, connectionId, 'SAML');
    const publicOrigin = publicRequestOrigin(request);
    if (!connection.certificate) {
      return Response.json({ error: 'SAML certificate is required.' }, { status: 409 });
    }
    const metadata = await withTenantDb(connection.organizationId, (db) => {
      const saml = new SAML({
        callbackUrl: callbackUrl(request, 'saml', connection.id),
        entryPoint: connection.ssoUrl ?? undefined,
        issuer: connection.entityId ?? publicOrigin,
        idpIssuer: connection.issuer ?? undefined,
        idpCert: connection.certificate!,
        audience: connection.entityId ?? publicOrigin,
        validateInResponseTo: ValidateInResponseTo.always,
        cacheProvider: new PrismaSamlCache(db, connection.organizationId, connection.id),
      });
      return Promise.resolve(saml.generateServiceProviderMetadata(null, null));
    });
    return new Response(metadata, {
      headers: {
        'Content-Type': 'application/samlmetadata+xml; charset=utf-8',
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (error) {
    console.error('[sso:saml:metadata]', error);
    return Response.json({ error: 'SAML metadata is not available.' }, { status: 400 });
  }
}
