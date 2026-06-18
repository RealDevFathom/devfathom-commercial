import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';

export const GET = withApiAuth('meetings:read', async (ctx) => {
  const meetings = await db.meeting.findMany({
    where: { attendees: { some: { userId: ctx.userId } } },
    include: { attendees: { include: { user: { select: { id: true, name: true } } } } },
    orderBy: { startTime: 'asc' },
  });
  return NextResponse.json({ data: meetings });
});

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  location: z.string().optional(),
  recurrence: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).nullable().optional(),
  attendeeIds: z.array(z.string()).default([]),
});

export const POST = withApiAuth('meetings:write', async (ctx, request) => {
  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { attendeeIds, startTime, endTime, ...rest } = parsed.data;
  const allAttendees = [...new Set([ctx.userId, ...attendeeIds])];

  const meeting = await db.meeting.create({
    data: {
      ...rest,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      createdById: ctx.userId,
      attendees: { create: allAttendees.map((userId) => ({ userId })) },
    },
  });
  return NextResponse.json({ data: meeting }, { status: 201 });
});
