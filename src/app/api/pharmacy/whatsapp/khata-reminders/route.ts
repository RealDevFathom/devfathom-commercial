import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { processDueWhatsAppKhataReminders } from '@/lib/pharmacy/whatsapp/khata-reminders';

/**
 * CRM-L06 — scheduled WhatsApp khata-reminder job. Called by the platform
 * scheduler with `Authorization: Bearer $CRON_SECRET`; safe to call as often as
 * desired because every reminder is claimed once per family account per week
 * before it is sent.
 */
export const maxDuration = 300;

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
  const input = (await request.json().catch(() => ({}))) as { limit?: unknown };
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 100;
  return NextResponse.json(await processDueWhatsAppKhataReminders({ limit }));
}
