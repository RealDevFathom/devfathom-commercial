import { NextResponse } from 'next/server';
import { readBoundedBody } from '@/lib/http/read-bounded-body';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { createLiveKitWebhookVerifier } from '@/server/meetings/provider/livekit';
import {
  recordAndApplyProviderEvent,
  resolveProviderRoom,
} from '@/server/meetings/provider/events';
import { MeetingProviderError } from '@/server/meetings/provider/types';

const MAX_BODY_BYTES = 256 * 1024;
const REJECTION = { error: 'Invalid webhook.' };

export async function POST(request: Request) {
  const gate = await rateLimit(`meetings-livekit:ip:${clientIp(request)}`, 600, 60_000);
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } }
    );
  }
  const rawBody = await readBoundedBody(request, MAX_BODY_BYTES);
  if (rawBody === null) return NextResponse.json(REJECTION, { status: 413 });

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) return NextResponse.json({ error: 'Unavailable.' }, { status: 503 });

  try {
    const event = await createLiveKitWebhookVerifier({ apiKey, apiSecret })(
      rawBody,
      request.headers
    );
    const occurrence = await resolveProviderRoom(event.roomName);
    if (!occurrence) return NextResponse.json({ ok: true });
    await recordAndApplyProviderEvent(occurrence, event);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof MeetingProviderError && error.code === 'invalid') {
      return NextResponse.json(REJECTION, { status: 400 });
    }
    return NextResponse.json({ error: 'Unavailable.' }, { status: 503 });
  }
}
