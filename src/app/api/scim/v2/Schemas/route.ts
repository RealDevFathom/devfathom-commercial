import { SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA, SCIM_USER_SCHEMA, scimJson } from '@/lib/scim';

export async function GET() {
  return scimJson({
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 2,
    Resources: [
      {
        id: SCIM_USER_SCHEMA,
        name: 'User',
        description: 'Organization user account',
        attributes: [
          { name: 'userName', type: 'string', required: true, uniqueness: 'server' },
          { name: 'displayName', type: 'string', required: false },
          { name: 'active', type: 'boolean', required: false },
          { name: 'roles', type: 'complex', multiValued: true, required: false },
        ],
        meta: { resourceType: 'Schema' },
      },
      {
        id: SCIM_GROUP_SCHEMA,
        name: 'Group',
        description: 'Organization role and membership',
        attributes: [
          { name: 'displayName', type: 'string', required: true },
          { name: 'members', type: 'complex', multiValued: true, required: false },
        ],
        meta: { resourceType: 'Schema' },
      },
    ],
  });
}
