import { NextResponse } from 'next/server';
import { withApiAuth } from '@/lib/api-auth';
import { canAccessProject } from '@/lib/authz';

export const GET = withApiAuth(
  'tasks:read',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const board = await authCtx.db.board.findUnique({
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
    // Object-level authz: the board's owning project must be accessible.
    if (!(await canAccessProject(authCtx.db, authCtx.userId, authCtx.userRole, board.projectId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ data: board });
  }
);
