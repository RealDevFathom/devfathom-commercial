import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { isAdmin } from '@/lib/authz';
import { logActivity } from '@/server/activity';

export const GET = withApiAuth('clients:read', async (ctx) => {
  // Clients are a finance/admin domain — listing the directory en masse must
  // require an admin-bound token (otherwise the /clients/[id] admin gate is
  // trivially bypassed by enumerating the collection).
  if (!isAdmin(ctx.userRole)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const clients = await db.client.findMany({
    include: {
      contacts: true,
      _count: { select: { projects: true, invoices: true } },
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
  const body = await request.json();
  const parsed = createClientSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const client = await db.client.create({ data: parsed.data });

  logActivity(db, ctx.userId, {
    type: 'client_created',
    message: `added client ${client.name}`,
    entityType: 'Client',
    entityId: client.id,
  });

  return NextResponse.json({ data: client }, { status: 201 });
});
