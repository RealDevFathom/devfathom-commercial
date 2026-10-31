import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { processDueWhatsAppLicenceRenewalReminders } from '@/lib/pharmacy/whatsapp/licence-renewal-reminders';

/**
 * #720 — scheduled owner-only WhatsApp licence renewal reminders. Called by the
 * platform scheduler with `Authorization: Bearer $CRON_SECRET`; safe to call as
 * often as desired because each reminder is claimed once per owner, licence,
 * expiry and stage before it is sent. Off until the template is configured.
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
  return NextResponse.json(await processDueWhatsAppLicenceRenewalReminders());
}
