import { NextResponse } from 'next/server';
import { createLiveKitWebhookVerifier } from '@/server/meetings/provider/livekit';
import {
  recordAndApplyProviderEvent,
  resolveProviderRoom,
} from '@/server/meetings/provider/events';
import { MeetingProviderError } from '@/server/meetings/provider/types';

const MAX_BODY_BYTES = 256 * 1024;
const REJECTION = { error: 'Invalid webhook.' };

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return NextResponse.json(REJECTION, { status: 400 });

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return NextResponse.json(REJECTION, { status: 400 });

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
