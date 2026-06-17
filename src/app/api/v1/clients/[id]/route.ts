import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';

export const GET = withApiAuth('clients:read', async (_ctx, _request, ctx: { params: Promise<{ id: string }> }) => {
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
});

export const DELETE = withApiAuth('clients:write', async (_ctx, _request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await db.client.delete({ where: { id } });
  return NextResponse.json({ success: true });
});
