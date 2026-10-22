import { NextResponse } from 'next/server';
import { z } from 'zod';
import { can } from '@/lib/abac';
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
  projectId: z.string().min(1).nullable().optional(),
  clientId: z.string().min(1).nullable().optional(),
  date: z.string().datetime().optional(),
});

export const PATCH = withApiAuth(
  'finance:write',
  async (authCtx, request, ctx: { params: Promise<{ id: string }> }) => {
    const allowed = await can(
      { id: authCtx.userId, role: authCtx.userRole },
      'finance:write',
      undefined,
      { db: authCtx.db, source: 'REST' }
    );
    if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

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
    const existing = await authCtx.db.transaction.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

    const { date, projectId, clientId, ...data } = parsed.data;
    if (
      projectId !== undefined &&
      projectId !== null &&
      !(await authCtx.db.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      }))
    ) {
      return NextResponse.json({ error: 'projectId does not exist.' }, { status: 400 });
    }
    if (
      clientId !== undefined &&
      clientId !== null &&
      !(await authCtx.db.client.findUnique({
        where: { id: clientId },
        select: { id: true },
      }))
    ) {
      return NextResponse.json({ error: 'clientId does not exist.' }, { status: 400 });
    }

    const transaction = await authCtx.db.transaction.update({
      where: { id },
      data: { ...data, projectId, clientId, ...(date && { date: new Date(date) }) },
    });
    return NextResponse.json({ data: transaction });
  }
);

export const DELETE = withApiAuth(
  'finance:write',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const existing = await authCtx.db.transaction.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    await authCtx.db.transaction.delete({ where: { id } });
    return NextResponse.json({ success: true });
  }
);
