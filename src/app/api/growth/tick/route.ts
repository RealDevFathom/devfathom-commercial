import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { runCustomerMetrics } from '@/lib/growth/metrics';
import { plannerAvailable, runWeeklyPlanner } from '@/lib/growth/planner';
import { isGrowthEnabled } from '@/lib/growth';
import { advanceCampaigns, dispatchCampaignMessages } from '@/lib/growth/campaigns';
import { withTenantDb, withPlatformDb } from '@/lib/tenancy/scoped-db';

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
    let enabled = false;
    try {
      enabled = await isGrowthEnabled(organization.id);
      if (enabled) {
        await runCustomerMetrics(organization.id);
        console.info(`[growth] tick organizationId=${organization.id}`);
      }
    } catch (error) {
      console.error(`[growth] tick failed organizationId=${organization.id}`, error);
    }
    if (!enabled) continue;
    // A metrics failure must not block planning or advancing already-approved sends.
    if (plannerAvailable()) {
      try {
        await withTenantDb(organization.id, (db) => runWeeklyPlanner(db, organization.id));
      } catch (error) {
        console.error(
          '[growth.planner] failed',
          organization.id,
          error instanceof Error ? error.name : 'UnknownError'
        );
      }
    }
    try {
      await withTenantDb(organization.id, (db) => advanceCampaigns(db, organization.id));
      await dispatchCampaignMessages(organization.id);
    } catch (error) {
      console.error(
        '[growth.dispatch] failed',
        organization.id,
        error instanceof Error ? error.name : 'UnknownError'
      );
    }
  }
  return NextResponse.json({ ok: true });
}

export const GET = POST;
