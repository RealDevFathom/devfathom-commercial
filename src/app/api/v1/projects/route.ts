import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { readJson } from '@/lib/api-json';
import { logActivity } from '@/server/activity';
import { PROJECT_DATE_ORDER_MESSAGE, projectDatesAreOrdered } from '@/lib/project-dates';

export const GET = withApiAuth('projects:read', async (ctx, request) => {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 1, 1), 1000) : undefined;
  // Object-level scoping: non-admins only see projects they are a member of.
  const where = ctx.userRole === 'ADMIN' ? {} : { members: { some: { userId: ctx.userId } } };
  const projects = await ctx.db.project.findMany({
    where,
    take: limit,
    include: {
      client: { select: { id: true, name: true } },
      members: { include: { user: { select: { id: true, name: true, email: true } } } },
      _count: { select: { boards: true, milestones: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return NextResponse.json({ data: projects });
});

const createProjectSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(['CLIENT', 'INTERNAL']),
    status: z.enum(['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED']).default('ACTIVE'),
    clientId: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    techStack: z.array(z.string()).default([]),
    memberIds: z.array(z.string()).default([]),
  })
  .refine((data) => projectDatesAreOrdered(data.startDate, data.endDate), {
    message: PROJECT_DATE_ORDER_MESSAGE,
    path: ['endDate'],
  });

export const POST = withApiAuth('projects:write', async (ctx, request) => {
  const __j = await readJson(request); // REST-05
  if (!__j.ok) return __j.response;
  const body = __j.data;
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { memberIds, startDate, endDate, ...data } = parsed.data;
  const allMembers = [...new Set([ctx.userId, ...memberIds])];

  const project = await ctx.db.project.create({
    data: {
      ...data,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      members: {
        create: allMembers.map((userId, i) => ({ userId, role: i === 0 ? 'LEAD' : 'MEMBER' })),
      },
      boards: {
        create: {
          name: `${data.name} Board`,
          columns: {
            create: ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'].map((name, order) => ({
              name,
              order,
            })),
          },
        },
      },
    },
  });

  logActivity(ctx.db, ctx.userId, {
    type: 'project_created',
    message: `created project ${project.name}`,
    entityType: 'Project',
    entityId: project.id,
  });

  return NextResponse.json({ data: project }, { status: 201 });
});
