import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { logActivity } from '@/server/activity';

export const GET = withApiAuth('finance:read', async (_ctx, _request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const invoice = await db.invoice.findUnique({
    where: { id },
    include: {
      client: { include: { contacts: true } },
      project: { select: { id: true, name: true } },
    },
  });
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  return NextResponse.json({ data: invoice });
});

const updateSchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']).optional(),
});

export const PATCH = withApiAuth('finance:write', async (authCtx, request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.issues }, { status: 400 });
  }

  const data: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.status === 'PAID') data.paidAt = new Date();
  if (parsed.data.status === 'SENT') data.sentAt = new Date();

  const invoice = await db.invoice.update({
    where: { id },
    data,
    include: { client: { select: { name: true } } },
  });

  if (parsed.data.status === 'SENT') {
    logActivity(db, authCtx.userId, {
      type: 'invoice_sent',
      message: `sent invoice ${invoice.invoiceNumber} to ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
      entityType: 'Invoice',
      entityId: invoice.id,
    });
  } else if (parsed.data.status === 'PAID') {
    logActivity(db, authCtx.userId, {
      type: 'invoice_paid',
      message: `marked invoice ${invoice.invoiceNumber} as paid ($${Number(invoice.total).toLocaleString()})`,
      entityType: 'Invoice',
      entityId: invoice.id,
    });
  }

  return NextResponse.json({ data: invoice });
});
