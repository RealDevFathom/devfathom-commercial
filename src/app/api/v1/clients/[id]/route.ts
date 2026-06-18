import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { isAdmin } from '@/lib/authz';

export const GET = withApiAuth(
  'clients:read',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    // Clients are a finance/admin domain — require an admin-bound token.
    if (!isAdmin(authCtx.userRole)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { id } = await ctx.params;
    const client = await db.client.findUnique({
      where: { id },
      include: {
        contacts: true,
        projects: { select: { id: true, name: true, status: true } },
        invoices: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    return NextResponse.json({ data: client });
  }
);

export const DELETE = withApiAuth(
  'clients:write',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    // Clients are a finance/admin domain — require an admin-bound token.
    if (!isAdmin(authCtx.userRole)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { id } = await ctx.params;
    const client = await db.client.findUnique({ where: { id }, select: { id: true } });
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    await db.client.delete({ where: { id } });
    return NextResponse.json({ success: true });
  }
);
