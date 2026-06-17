import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';

export const GET = withApiAuth('tasks:read', async (_ctx, _request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const board = await db.board.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, name: true } },
      labels: true,
      columns: {
        orderBy: { order: 'asc' },
        include: {
          tasks: {
            orderBy: { order: 'asc' },
            include: {
              assignees: { include: { user: { select: { id: true, name: true } } } },
              labels: { include: { label: true } },
            },
          },
        },
      },
    },
  });
  if (!board) return NextResponse.json({ error: 'Board not found' }, { status: 404 });
  return NextResponse.json({ data: board });
});
