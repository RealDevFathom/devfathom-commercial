import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiAuth } from '@/lib/api-auth';
import { readJson } from '@/lib/api-json';
import { authorizeGuestOccurrence } from '@/lib/meetings/guest-access';
import { clientIp, rateLimit } from '@/lib/rate-limit';

export const GET = withApiAuth('meetings:read', async (ctx, request) => {
  const url = new URL(request.url);
  // REST-06 (#45): an omitted ?limit used to mean `take: undefined`, i.e. every
  // meeting the token's user attends with the full attendee graph in one
  // response. This route calls Prisma directly rather than the meetings router,
  // so #38's server-side default never reached it. Same shape as /tasks and
  // /transactions: NaN-safe, defaults to 50, clamped into [1, 100]. The ceiling
  // is the tighter of the two siblings because every row here carries its
  // attendee graph.
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1),
    100
  );
  const meetings = await ctx.db.meeting.findMany({
    where: { attendees: { some: { userId: ctx.userId } } },
    take: limit,
    include: { attendees: { include: { user: { select: { id: true, name: true } } } } },
    // `startTime` alone is not a total order: meetings that share an instant
    // could come back in whatever order the plan produced, so a bounded page
    // over them would vary between identical calls. `id` is unique, which makes
    // the sort total.
    orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
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
  const foundAttendees = await ctx.db.user.count({ where: { id: { in: allAttendees } } });
  if (foundAttendees !== allAttendees.length) {
    return NextResponse.json({ error: 'One or more attendeeIds do not exist.' }, { status: 400 });
  }

  const meeting = await ctx.db.meeting.create({
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

const guestJoinSchema = z.object({
  publicId: z.string().min(8).max(128),
  secret: z.string().min(32).max(512),
});

/** Guest secrets are accepted in the request body only; never in URLs or logs. */
export async function PUT(request: Request) {
  const gate = rateLimit(`meeting-guest:${clientIp(request)}`, 20, 60_000);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many requests.' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } }
    );
  }
  const json = await readJson(request);
  if (!json.ok) return json.response;
  const parsed = guestJoinSchema.safeParse(json.data);
  if (!parsed.success)
    return NextResponse.json({ error: 'Invalid join credentials.' }, { status: 400 });
  const occurrence = await authorizeGuestOccurrence(parsed.data.publicId, parsed.data.secret);
  if (!occurrence)
    return NextResponse.json({ error: 'Invalid join credentials.' }, { status: 401 });
  const now = new Date();
  if (
    occurrence.status === 'CANCELLED' ||
    now < occurrence.joinOpensAt ||
    now > occurrence.joinClosesAt
  ) {
    return NextResponse.json({ error: 'This occurrence is not joinable.' }, { status: 403 });
  }
  return NextResponse.json({ data: occurrence });
}
