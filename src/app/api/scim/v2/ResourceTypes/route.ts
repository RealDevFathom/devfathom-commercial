import { SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA, SCIM_USER_SCHEMA, scimJson } from '@/lib/scim';
import { publicRequestOrigin } from '@/lib/http-origin';

export async function GET(request: Request) {
  const base = publicRequestOrigin(request);
  return scimJson({
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 2,
    Resources: [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        schema: SCIM_USER_SCHEMA,
        meta: { resourceType: 'ResourceType', location: `${base}/api/scim/v2/ResourceTypes/User` },
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        schema: SCIM_GROUP_SCHEMA,
        meta: { resourceType: 'ResourceType', location: `${base}/api/scim/v2/ResourceTypes/Group` },
      },
    ],
  });
}
