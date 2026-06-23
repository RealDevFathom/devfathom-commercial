import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { readJson } from '@/lib/api-json';

const updateSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
  amount: z.number().positive().optional(),
  description: z.string().min(1).optional(),
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
    .nullable()
    .optional(),
  projectId: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  date: z.string().datetime().optional(),
});

export const PATCH = withApiAuth(
  'finance:write',
  async (_ctx, request, ctx: { params: Promise<{ id: string }> }) => {
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
    const existing = await db.transaction.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

    const { date, ...data } = parsed.data;
    const transaction = await db.transaction.update({
      where: { id },
      data: { ...data, ...(date && { date: new Date(date) }) },
    });
    return NextResponse.json({ data: transaction });
  }
);

export const DELETE = withApiAuth(
  'finance:write',
  async (_ctx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const existing = await db.transaction.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    await db.transaction.delete({ where: { id } });
    return NextResponse.json({ success: true });
  }
);
