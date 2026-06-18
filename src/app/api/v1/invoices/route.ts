import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { logActivity } from '@/server/activity';

export const GET = withApiAuth('finance:read', async (_ctx, request) => {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const clientId = url.searchParams.get('clientId');

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (clientId) where.clientId = clientId;

  const invoices = await db.invoice.findMany({
    where,
    include: {
      client: { select: { id: true, name: true } },
      project: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ data: invoices });
});

const lineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().positive(),
  rate: z.number().positive(),
  amount: z.number(),
});

const createInvoiceSchema = z.object({
  clientId: z.string(),
  projectId: z.string().optional(),
  items: z.array(lineItemSchema).min(1),
  subtotal: z.number(),
  tax: z.number().default(0),
  total: z.number(),
  currency: z.enum(['USD', 'PKR']).default('USD'),
  dueDate: z.string().datetime(),
  notes: z.string().optional(),
});

export const POST = withApiAuth('finance:write', async (ctx, request) => {
  const body = await request.json();
  const parsed = createInvoiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const count = await db.invoice.count();
  const year = new Date().getFullYear();
  const invoiceNumber = `INV-${year}-${String(count + 1).padStart(3, '0')}`;

  const invoice = await db.invoice.create({
    data: {
      invoiceNumber,
      clientId: parsed.data.clientId,
      projectId: parsed.data.projectId || null,
      items: parsed.data.items,
      subtotal: parsed.data.subtotal,
      tax: parsed.data.tax,
      total: parsed.data.total,
      currency: parsed.data.currency,
      status: 'DRAFT',
      dueDate: new Date(parsed.data.dueDate),
      notes: parsed.data.notes,
    },
    include: { client: { select: { name: true } } },
  });

  logActivity(db, ctx.userId, {
    type: 'invoice_created',
    message: `created invoice ${invoice.invoiceNumber} for ${invoice.client.name} ($${Number(invoice.total).toLocaleString()})`,
    entityType: 'Invoice',
    entityId: invoice.id,
  });

  return NextResponse.json({ data: invoice }, { status: 201 });
});
