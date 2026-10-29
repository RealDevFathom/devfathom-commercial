import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { logActivity } from '@/server/activity';
import { readJson } from '@/lib/api-json';
import { multiplyMoney, roundMoney } from '@/lib/finance/money';

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
const MAX_MONEY = 9_999_999_999.99;

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
  items: z.array(lineItemSchema).min(1),
  // subtotal/total are intentionally NOT accepted — they are derived server-side.
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

  // FIN-01: derive line amounts, subtotal and total on the server from
  // quantity × rate (+ tax). Client-sent subtotal/total are never used.
  const items = parsed.data.items.map((it) => ({
    description: it.description,
    quantity: it.quantity,
    rate: it.rate,
    amount: multiplyMoney(it.quantity, it.rate),
  }));
  const subtotal = roundMoney(items.reduce((s, it) => s + it.amount, 0));
  const tax = roundMoney(parsed.data.tax);
  const total = roundMoney(subtotal + tax);

  // FIN-09: per-year sequence — scope the count to this year so it resets to -001.
  const year = new Date().getFullYear();
  const count = await ctx.db.invoice.count({
    where: { invoiceNumber: { startsWith: `INV-${year}-` } },
  });
  const invoiceNumber = `INV-${year}-${String(count + 1).padStart(3, '0')}`;

  const invoice = await ctx.db.invoice.create({
    data: {
      invoiceNumber,
      clientId: parsed.data.clientId,
      projectId: parsed.data.projectId || null,
      items,
      subtotal,
      tax,
      total,
      currency: parsed.data.currency,
      status: 'DRAFT',
      dueDate: new Date(parsed.data.dueDate),
      notes: parsed.data.notes,
    },
    include: { client: { select: { name: true } } },
  });

  logActivity(ctx.db, ctx.userId, {
    type: 'invoice_created',
    message: `created invoice ${invoice.invoiceNumber} for ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
    entityType: 'Invoice',
    entityId: invoice.id,
  });

  return NextResponse.json({ data: invoice }, { status: 201 });
});
