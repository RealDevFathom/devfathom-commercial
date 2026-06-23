import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';

// Money columns are Decimal(12,2) — Postgres caps a value at 9,999,999,999.99.
const MAX_MONEY = 9_999_999_999.99;

export const GET = withApiAuth('finance:read', async (_ctx, request) => {
  const url = new URL(request.url);
  const type = url.searchParams.get('type'); // INCOME or EXPENSE
  const startDate = url.searchParams.get('startDate');
  const endDate = url.searchParams.get('endDate');
  const category = url.searchParams.get('category');
  // REST-06: NaN-safe — a non-numeric ?limit= must not reach Prisma as take:NaN.
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);

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
    take: limit,
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
  // FIN-07: bound money so an overflow value is a clean 400, not a raw DB 500.
  amount: z.number().positive().max(MAX_MONEY),
  currency: z.enum(['USD', 'PKR']).default('USD'),
  description: z.string().min(1),
  category: z
    .enum([
      'SALARIES',
      'SUBSCRIPTIONS',
      'OFFICE',
      'MARKETING',
      'HOSTING',
      'SOFTWARE',
      'HARDWARE',
      'TRAVEL',
      'UTILITIES',
      'MISCELLANEOUS',
    ])
    .optional(),
  projectId: z.string().optional(),
  clientId: z.string().optional(),
  date: z.string().datetime(),
});

export const POST = withApiAuth('finance:write', async (_ctx, request) => {
  const body = await request.json();
  const parsed = createTransactionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
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
