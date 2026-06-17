import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';

export const GET = withApiAuth('finance:read', async (_ctx, request) => {
  const url = new URL(request.url);
  const type = url.searchParams.get('type'); // INCOME or EXPENSE
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  const category = url.searchParams.get('category');
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);

  const where: Record<string, unknown> = {};
  if (type) where.type = type;
  if (category) where.category = category;
  if (startDate || endDate) {
    where.date = {
      ...(startDate && { gte: new Date(startDate) }),
      ...(endDate && { lte: new Date(endDate) }),
    };
  }

  const transactions = await db.transaction.findMany({
    where,
    take: Math.min(limit, 200),
    orderBy: { date: 'desc' },
    include: {
      project: { select: { id: true, name: true } },
      client: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({ data: transactions });
});

const createTransactionSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE']),
  amount: z.number().positive(),
  currency: z.enum(['USD', 'PKR']).default('USD'),
  description: z.string().min(1),
  category: z.enum(['SALARIES', 'SUBSCRIPTIONS', 'OFFICE', 'MARKETING', 'HOSTING', 'SOFTWARE', 'HARDWARE', 'TRAVEL', 'UTILITIES', 'MISCELLANEOUS']).optional(),
  projectId: z.string().optional(),
  clientId: z.string().optional(),
  date: z.string().datetime(),
});

export const POST = withApiAuth('finance:write', async (_ctx, request) => {
  const body = await request.json();
  const parsed = createTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.issues }, { status: 400 });
  }

  const { date, projectId, clientId, category, ...rest } = parsed.data;
  const transaction = await db.transaction.create({
    data: {
      ...rest,
      date: new Date(date),
      projectId: projectId || null,
      clientId: clientId || null,
      category: category || null,
    },
  });

  return NextResponse.json({ data: transaction }, { status: 201 });
});
