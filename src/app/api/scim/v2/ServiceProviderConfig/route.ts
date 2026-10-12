import { scimJson } from '@/lib/scim';

export async function GET() {
  return scimJson({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: true },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'Organization-scoped SCIM bearer token.',
        specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
        primary: true,
      },
    ],
  });
}
