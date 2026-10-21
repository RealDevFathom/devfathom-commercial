import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { readJson } from '@/lib/api-json';
import { logActivity } from '@/server/activity';

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

const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['OVERDUE', 'CANCELLED', 'DRAFT'],
  OVERDUE: ['CANCELLED', 'SENT'],
  PAID: ['CANCELLED'],
  CANCELLED: ['DRAFT'],
};

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
      include: { client: { select: { name: true } } },
    });
    if (!existing) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    const next = parsed.data.status;
    if (next === 'PAID') {
      return NextResponse.json(
        { error: 'Record a payment to mark an invoice as paid.' },
        { status: 400 }
      );
    }

    if (next === existing.status) return NextResponse.json({ data: existing });

    if (
      next &&
      next !== existing.status &&
      !ALLOWED_STATUS_TRANSITIONS[existing.status]?.includes(next)
    ) {
      return NextResponse.json(
        { error: `Cannot change an invoice from ${existing.status} to ${next}.` },
        { status: 400 }
      );
    }

    const data: Record<string, unknown> = { ...parsed.data };
    if (next === 'SENT') data.sentAt = new Date();
    if (existing.status === 'PAID') data.paidAt = null;
    if (next === 'DRAFT') {
      data.sentAt = null;
      data.paidAt = null;
    }

    const invoice = await authCtx.db.invoice.update({
      where: { id },
      data,
      include: { client: { select: { name: true } } },
    });

    if (next === 'SENT' && existing.status !== 'SENT') {
      logActivity(authCtx.db, authCtx.userId, {
        type: 'invoice_sent',
        message: `sent invoice ${invoice.invoiceNumber} to ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
        entityType: 'Invoice',
        entityId: invoice.id,
      });
    }

    return NextResponse.json({ data: invoice });
  }
);
