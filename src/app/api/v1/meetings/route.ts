import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';
import { readJson } from '@/lib/api-json';

export const GET = withApiAuth('meetings:read', async (ctx, request) => {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 1, 1), 1000) : undefined;
  const meetings = await db.meeting.findMany({
    where: { attendees: { some: { userId: ctx.userId } } },
    take: limit,
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
  const __j = await readJson(request); // REST-05
  if (!__j.ok) return __j.response;
  const body = __j.data;
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { attendeeIds, startTime, endTime, ...rest } = parsed.data;
  const allAttendees = [...new Set([ctx.userId, ...attendeeIds])];

  // REST-07: validate attendee ids exist before insert (bad id → raw FK 500).
  const foundAttendees = await db.user.count({ where: { id: { in: allAttendees } } });
  if (foundAttendees !== allAttendees.length) {
    return NextResponse.json({ error: 'One or more attendeeIds do not exist.' }, { status: 400 });
  }

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
