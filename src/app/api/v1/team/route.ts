import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { withApiAuth } from '@/lib/api-auth';

export const GET = withApiAuth('team:read', async () => {
  const team = await db.user.findMany({
    select: {
      id: true, name: true, email: true, role: true, department: true,
      title: true, avatar: true, phone: true, bio: true, skills: true,
      status: true, startDate: true,
    },
    orderBy: { name: 'asc' },
  });
  return NextResponse.json({ data: team });
});
