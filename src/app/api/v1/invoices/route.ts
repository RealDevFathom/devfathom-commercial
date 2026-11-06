import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { logActivity } from '@/server/activity';
import { readJson } from '@/lib/api-json';
import { createWithNextInvoiceNumber } from '@/lib/finance/invoice-number';
import { MAX_MONEY } from '@/lib/finance/money';
import { computeInvoiceAmounts } from '@/lib/finance/invoice-amounts';

export const GET = withApiAuth('finance:read', async (ctx, request) => {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const clientId = url.searchParams.get('clientId');
  const cursor = url.searchParams.get('cursor');
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 1, 1), 1000) : undefined;

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (clientId) where.clientId = clientId;

  const invoices = await ctx.db.invoice.findMany({
    where,
    take: limit,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    include: {
      client: { select: { id: true, name: true } },
      project: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ data: invoices });
});

// Money columns are Decimal(12,2): Postgres caps a value at 9,999,999,999.99.
// Bound + non-negative so an oversized/negative input is a clean 400, not a raw
// DB 500 (FIN-07) and not a paid/outstanding-corrupting negative (FIN-01).
const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive().max(1_000_000),
  rate: z.number().nonnegative().max(MAX_MONEY),
  // amount is accepted for backward-compat but ignored — the server recomputes
  // it from quantity × rate so a forged amount cannot skew the total.
  amount: z.number().optional(),
});

const createInvoiceSchema = z.object({
  clientId: z.string(),
  projectId: z.string().optional(),
  items: z.array(lineItemSchema).min(1).max(1_000),
  // subtotal/total are intentionally NOT accepted — they are derived server-side.
  // #448: discount and tax are currency AMOUNTS (not rates). total = subtotal −
  // discount + tax, and a discount above the subtotal is a 400.
  discount: z.number().nonnegative().max(MAX_MONEY).default(0),
  tax: z.number().nonnegative().max(MAX_MONEY).default(0),
  currency: z.enum(['USD', 'PKR']).default('USD'),
  dueDate: z.string().datetime(),
  notes: z.string().optional(),
});

export const POST = withApiAuth('finance:write', async (ctx, request) => {
  const json = await readJson(request); // REST-05: malformed JSON → 400, not 500
  if (!json.ok) return json.response;
  const parsed = createInvoiceSchema.safeParse(json.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }

  // FIN-01: derive line amounts, subtotal and total on the server with the one
  // shared invoice calculation (lines rounded to cents, subtotal = Σ lines,
  // total = subtotal − discount + tax). Client-sent subtotal/total are never used.
  const computed = computeInvoiceAmounts(parsed.data);
  if (!computed.ok) {
    return NextResponse.json(
      { error: 'Invalid input', details: [{ path: [computed.field], message: computed.message }] },
      { status: 400 }
    );
  }
  const { items, subtotal, discount, tax, total } = computed.amounts;

  // Same per-organization, per-year INV sequence as finance.createInvoice.
  const invoice = await createWithNextInvoiceNumber(ctx.db, (tx, invoiceNumber) =>
    tx.invoice.create({
      data: {
        invoiceNumber,
        clientId: parsed.data.clientId,
        projectId: parsed.data.projectId || null,
        items,
        subtotal,
        discount,
        tax,
        total,
        currency: parsed.data.currency,
        status: 'DRAFT',
        dueDate: new Date(parsed.data.dueDate),
        notes: parsed.data.notes,
      },
      include: { client: { select: { name: true } } },
    })
  );

  logActivity(ctx.db, ctx.userId, {
    type: 'invoice_created',
    message: `created invoice ${invoice.invoiceNumber} for ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
    entityType: 'Invoice',
    entityId: invoice.id,
  });

  return NextResponse.json({ data: invoice }, { status: 201 });
});
