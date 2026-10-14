import {
  requestBaseUrl,
  SCIM_GROUP_SCHEMA,
  SCIM_LIST_SCHEMA,
  scimError,
  scimJson,
  withScimAuth,
} from '@/lib/scim';

function groupResource(
  role: {
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
    users: Array<{ id: string; name: string }>;
  },
  baseUrl: string
) {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: role.id,
    displayName: role.name,
    members: role.users.map((user) => ({
      value: user.id,
      display: user.name,
      $ref: `${baseUrl}/api/scim/v2/Users/${user.id}`,
    })),
    meta: {
      resourceType: 'Group',
      created: role.createdAt.toISOString(),
      lastModified: role.updatedAt.toISOString(),
      version: `W/"${role.updatedAt.getTime()}"`,
      location: `${baseUrl}/api/scim/v2/Groups/${role.id}`,
    },
  };
}

export async function GET(request: Request) {
  return withScimAuth(request, async (ctx) => {
    const url = new URL(request.url);
    const startIndex = Math.max(1, Number(url.searchParams.get('startIndex') ?? 1) || 1);
    const count = Math.min(200, Math.max(1, Number(url.searchParams.get('count') ?? 100) || 100));
    const filter = url.searchParams.get('filter');
    let displayName: string | null = null;
    if (filter) {
      displayName = /^displayName\s+eq\s+"([^"]+)"$/i.exec(filter.trim())?.[1] ?? null;
      if (!displayName) {
        return scimError(400, 'Only displayName eq "name" filters are supported.', 'invalidFilter');
      }
    }
    const where = displayName ? { name: displayName } : {};
    const [roles, totalResults] = await Promise.all([
      ctx.db.organizationRole.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: startIndex - 1,
        take: count,
        include: { users: { select: { id: true, name: true } } },
      }),
      ctx.db.organizationRole.count({ where }),
    ]);
    const baseUrl = requestBaseUrl(request);
    return scimJson({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults,
      startIndex,
      itemsPerPage: roles.length,
      Resources: roles.map((role) => groupResource(role, baseUrl)),
    });
  });
}

export async function POST() {
  return scimError(
    403,
    'Groups are managed by organization administrators; SCIM may manage membership only.',
    'mutability'
  );
}
