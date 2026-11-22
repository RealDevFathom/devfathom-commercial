import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth, canIncludeAdminResource } from '@/lib/api-auth';
import { isAdmin } from '@/lib/authz';
import { logActivity } from '@/server/activity';
import { readJson } from '@/lib/api-json';

export const GET = withApiAuth('clients:read', async (ctx, request) => {
  // Clients are a finance/admin domain — listing the directory en masse must
  // require an admin-bound token (otherwise the /clients/[id] admin gate is
  // trivially bypassed by enumerating the collection).
  if (!isAdmin(ctx.userRole)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 1, 1), 1000) : undefined;
  const includeProjects = canIncludeAdminResource(ctx, 'projects:read');
  const includeFinance = canIncludeAdminResource(ctx, 'finance:read');
  const clients = await ctx.db.client.findMany({
    take: limit,
    include: {
      contacts: true,
      ...(includeProjects || includeFinance
        ? {
            _count: {
              select: {
                ...(includeProjects ? { projects: true } : {}),
                ...(includeFinance ? { invoices: true } : {}),
              },
            },
          }
        : {}),
    },
    orderBy: { name: 'asc' },
  });
  return NextResponse.json({ data: clients });
});

const createClientSchema = z.object({
  name: z.string().min(1),
  website: z.string().optional(),
  industry: z.string().optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
});

export const POST = withApiAuth('clients:write', async (ctx, request) => {
  // Clients are a finance/admin domain — require an admin-bound token.
  if (!isAdmin(ctx.userRole)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const json = await readJson(request); // REST-05: malformed JSON → 400, not 500
  if (!json.ok) return json.response;
  const parsed = createClientSchema.safeParse(json.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const client = await ctx.db.client.create({ data: parsed.data });

  logActivity(ctx.db, ctx.userId, {
    type: 'client_created',
    message: `added client ${client.name}`,
    entityType: 'Client',
    entityId: client.id,
  });

  return NextResponse.json({ data: client }, { status: 201 });
});
