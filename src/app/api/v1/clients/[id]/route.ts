import { NextResponse } from 'next/server';
import { withApiAuth, hasScope } from '@/lib/api-auth';
import { isAdmin } from '@/lib/authz';

export const GET = withApiAuth(
  'clients:read',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    // Clients are a finance/admin domain — require an admin-bound token.
    if (!isAdmin(authCtx.userRole)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { id } = await ctx.params;
    // REST-01: a clients:read token must NOT carry finance data. Only embed
    // invoices when the token ALSO holds finance:read — otherwise the finance
    // admin double-gate is bypassed via the client object.
    const includeFinance = hasScope(authCtx, 'finance:read');
    const client = await authCtx.db.client.findUnique({
      where: { id },
      include: {
        contacts: true,
        projects: { select: { id: true, name: true, status: true } },
        ...(includeFinance ? { invoices: { orderBy: { createdAt: 'desc' as const } } } : {}),
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
    const client = await authCtx.db.client.findUnique({ where: { id }, select: { id: true } });
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    await authCtx.db.client.delete({ where: { id } });
    return NextResponse.json({ success: true });
  }
);
