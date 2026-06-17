import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { logActivity } from '@/server/activity';

export const GET = withApiAuth('projects:read', async () => {
  const projects = await db.project.findMany({
    include: {
      client: { select: { id: true, name: true } },
      members: { include: { user: { select: { id: true, name: true, email: true } } } },
      _count: { select: { boards: true, milestones: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return NextResponse.json({ data: projects });
});

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['CLIENT', 'INTERNAL']),
  status: z.enum(['ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED']).default('ACTIVE'),
  clientId: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  techStack: z.array(z.string()).default([]),
  memberIds: z.array(z.string()).default([]),
});

export const POST = withApiAuth('projects:write', async (ctx, request) => {
  const body = await request.json();
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.issues }, { status: 400 });
  }
  const { memberIds, startDate, endDate, ...data } = parsed.data;
  const allMembers = [...new Set([ctx.userId, ...memberIds])];

  const project = await db.project.create({
    data: {
      ...data,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      members: { create: allMembers.map((userId, i) => ({ userId, role: i === 0 ? 'LEAD' : 'MEMBER' })) },
      boards: {
        create: {
          name: `${data.name} Board`,
          columns: { create: ['Backlog', 'To Do', 'In Progress', 'Review', 'Done'].map((name, order) => ({ name, order })) },
        },
      },
    },
  });

  logActivity(db, ctx.userId, {
    type: 'project_created',
    message: `created project ${project.name}`,
    entityType: 'Project',
    entityId: project.id,
  });

  return NextResponse.json({ data: project }, { status: 201 });
});
