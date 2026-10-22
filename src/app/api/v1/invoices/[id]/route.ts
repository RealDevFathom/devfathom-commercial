import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { readJson } from '@/lib/api-json';
import { logActivity } from '@/server/activity';
import { invoiceStatusUpdate, type InvoiceStatus } from '@/lib/finance/invoice-status';

export const GET = withApiAuth(
  'finance:read',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const invoice = await authCtx.db.invoice.findUnique({
      where: { id },
      include: {
        client: { include: { contacts: true } },
        project: { select: { id: true, name: true } },
      },
    });
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    return NextResponse.json({ data: invoice });
  }
);

const updateSchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']).optional(),
});

export const PATCH = withApiAuth(
  'finance:write',
  async (authCtx, request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const __j = await readJson(request); // REST-05
    if (!__j.ok) return __j.response;
    const body = __j.data;
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.issues },
        { status: 400 }
      );
    }

    const existing = await authCtx.db.invoice.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    const data = parsed.data.status
      ? invoiceStatusUpdate(existing.status as InvoiceStatus, parsed.data.status)
      : parsed.data;

    const invoice = await authCtx.db.invoice.update({
      where: { id },
      data,
      include: { client: { select: { name: true } } },
    });

    if (parsed.data.status === 'SENT') {
      logActivity(authCtx.db, authCtx.userId, {
        type: 'invoice_sent',
        message: `sent invoice ${invoice.invoiceNumber} to ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
        entityType: 'Invoice',
        entityId: invoice.id,
      });
    } else if (parsed.data.status === 'PAID') {
      logActivity(authCtx.db, authCtx.userId, {
        type: 'invoice_paid',
        message: `marked invoice ${invoice.invoiceNumber} as paid ($${Number(invoice.total).toLocaleString()})`,
        entityType: 'Invoice',
        entityId: invoice.id,
      });
    }

    return NextResponse.json({ data: invoice });
  }
);
