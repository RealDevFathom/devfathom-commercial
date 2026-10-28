import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { isGrowthEnabled } from '@/lib/growth';
import { drainOrganizationQueue } from '@/lib/growth/whatsapp/queue';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization');
  if (!secret || !authorization || !safeEqual(authorization, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const organizations = await withPlatformDb((db) =>
    db.organization.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
  );
  for (const organization of organizations) {
    if (await isGrowthEnabled(organization.id)) {
      console.info(`[growth] tick organizationId=${organization.id}`);
      try {
        await drainOrganizationQueue(organization.id);
      } catch {
        console.error(`[growth] tick failed organizationId=${organization.id}`);
      }
    }
  }
  return NextResponse.json({ ok: true });
}

export const GET = POST;
