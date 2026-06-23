import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { readJson } from '@/lib/api-json';

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
  const cursor = url.searchParams.get('cursor'); // REST-02: cursor pagination

  const where: Record<string, unknown> = {};
  if (type) where.type = type;
  if (category) where.category = category;
  if (startDate || endDate) {
    where.date = {
      ...(startDate && { gte: new Date(startDate) }),
      ...(endDate && { lte: new Date(endDate) }),
    };
  }

  // REST-02: consistent { data, nextCursor } envelope (fetch one extra to detect more).
  const rows = await db.transaction.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { date: 'desc' },
    include: {
      project: { select: { id: true, name: true } },
      client: { select: { id: true, name: true } },
    },
  });

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].id : null;
  return NextResponse.json({ data, nextCursor });
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
  const json = await readJson(request); // REST-05: malformed JSON → 400, not 500
  if (!json.ok) return json.response;
  const parsed = createTransactionSchema.safeParse(json.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { date, projectId, clientId, category, ...rest } = parsed.data;

  // REST-07: validate FKs exist before insert (else a bad id is a raw FK 500).
  if (projectId && !(await db.project.findUnique({ where: { id: projectId }, select: { id: true } }))) {
    return NextResponse.json({ error: 'projectId does not exist.' }, { status: 400 });
  }
  if (clientId && !(await db.client.findUnique({ where: { id: clientId }, select: { id: true } }))) {
    return NextResponse.json({ error: 'clientId does not exist.' }, { status: 400 });
  }

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
