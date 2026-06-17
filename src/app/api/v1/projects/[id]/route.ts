import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';

export const GET = withApiAuth('projects:read', async (_ctx, _request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const project = await db.project.findUnique({
    where: { id },
    include: {
      client: true,
      members: { include: { user: { select: { id: true, name: true, email: true } } } },
      boards: { include: { columns: { orderBy: { order: 'asc' }, include: { _count: { select: { tasks: true } } } } } },
      milestones: { orderBy: { dueDate: 'asc' } },
    },
  });
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  return NextResponse.json({ data: project });
});

export const DELETE = withApiAuth('projects:write', async (_ctx, _request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  await db.project.delete({ where: { id } });
  return NextResponse.json({ success: true });
});
