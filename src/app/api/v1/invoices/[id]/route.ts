import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { readJson } from '@/lib/api-json';
import { logActivity } from '@/server/activity';
import { readInvoiceIssuer } from '@/lib/finance/invoice-issuer';
import {
  INVOICE_STATUS_VALUES,
  invoiceStatusTransitionError,
  invoiceStatusUpdate,
  type InvoiceStatusValue,
} from '@/lib/finance/invoice-status';

export const GET = withApiAuth(
  'finance:read',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    // #458: the seller is the token's own workspace, read under the same
    // tenant-scoped client and explicit organization predicate as the invoice.
    const [invoice, issuer] = await Promise.all([
      authCtx.db.invoice.findUnique({
        where: { id, organizationId: authCtx.organizationId },
        include: {
          client: { include: { contacts: true } },
          project: { select: { id: true, name: true } },
        },
      }),
      readInvoiceIssuer(authCtx.db, authCtx.organizationId),
    ]);
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    return NextResponse.json({ data: { ...invoice, issuer } });
  }
);

const updateSchema = z.object({
  // Parse the same status domain enforced by the shared transition machine below.
  // Keeping one canonical list prevents this REST surface from accepting a new
  // status before its transition rules (and the other API surfaces) are ready.
  status: z.enum(INVOICE_STATUS_VALUES).optional(),
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
      include: { client: { select: { name: true } } },
    });
    if (!existing) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    const next = parsed.data.status;
    const transitionError = next
      ? invoiceStatusTransitionError(existing.status as InvoiceStatusValue, next)
      : null;
    if (transitionError) {
      return NextResponse.json({ error: transitionError }, { status: 400 });
    }

    if (next === existing.status) return NextResponse.json({ data: existing });
    if (!next) return NextResponse.json({ data: existing });

    // Compare-and-set makes the state check and write one atomic operation. Only
    // the request that wins this update may emit transition side effects.
    const changed = await authCtx.db.invoice.updateMany({
      where: { id, status: existing.status },
      data: invoiceStatusUpdate(existing.status as InvoiceStatusValue, next, new Date()),
    });
    if (changed.count !== 1) {
      return NextResponse.json(
        { error: 'Invoice status changed concurrently. Refresh and try again.' },
        { status: 409 }
      );
    }
    const invoice = await authCtx.db.invoice.findUniqueOrThrow({
      where: { id },
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
