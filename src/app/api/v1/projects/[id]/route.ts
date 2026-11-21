import { NextResponse } from 'next/server';
import { withApiAuth } from '@/lib/api-auth';
import { canAccessProject, canManageProject } from '@/lib/authz';

export const GET = withApiAuth(
  'projects:read',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const project = await authCtx.db.project.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true } },
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
        boards: {
          include: {
            columns: {
              orderBy: { order: 'asc' },
              include: { _count: { select: { tasks: true } } },
            },
          },
        },
        milestones: { orderBy: { dueDate: 'asc' } },
      },
    });
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    // Object-level authz: the acting user must be an admin or a project member.
    if (!(await canAccessProject(authCtx.db, authCtx.userId, authCtx.userRole, id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ data: project });
  }
);

export const DELETE = withApiAuth(
  'projects:write',
  async (authCtx, _request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const project = await authCtx.db.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    // Destructive op: require admin or project LEAD.
    if (!(await canManageProject(authCtx.db, authCtx.userId, authCtx.userRole, id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    await authCtx.db.project.delete({ where: { id } });
    return NextResponse.json({ success: true });
  }
);
