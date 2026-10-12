import { NextResponse } from 'next/server';
import { withApiAuth } from '@/lib/api-auth';
import { isAdmin } from '@/lib/authz';

export const GET = withApiAuth('team:read', async (ctx) => {
  const admin = isAdmin(ctx.userRole);
  const team = await ctx.db.user.findMany({
    select: {
      // Directory fields — safe for any team:read token (needed for assignee
      // / user-ID lookups documented in the API spec).
      id: true,
      name: true,
      email: true,
      role: true,
      title: true,
      avatar: true,
      // Sensitive PII / HR fields — only exposed to admin-bound tokens.
      ...(admin
        ? {
            department: true,
            phone: true,
            bio: true,
            skills: true,
            status: true,
            startDate: true,
          }
        : {}),
    },
    orderBy: { name: 'asc' },
  });
  return NextResponse.json({ data: team });
});
