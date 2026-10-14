import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';
import {
  MeetingProviderError,
  meetingProviderCapabilities,
  type MeetingProviderAdapter,
  type NormalizedMeetingEvent,
  type ProviderRoomState,
} from './types';

const liveKitWebhookSchema = z.object({
  id: z.string().min(1).optional(),
  event: z.string().min(1),
  createdAt: z.number().int().positive(),
  room: z.object({ name: z.string().min(1) }),
  participant: z.object({ sid: z.string().min(1), identity: z.string().min(1) }).optional(),
});

const eventTypes = {
  room_started: 'room.started',
  room_finished: 'room.finished',
  participant_joined: 'participant.joined',
  participant_left: 'participant.left',
} as const;

export const liveKitCapabilities = meetingProviderCapabilities;

type LiveKitVerifierOptions = {
  apiKey: string;
  apiSecret: string;
  now?: () => Date;
  replayWindowMs?: number;
};

export function createLiveKitWebhookVerifier({
  apiKey,
  apiSecret,
  now = () => new Date(),
  replayWindowMs = 10 * 60 * 1000,
}: LiveKitVerifierOptions) {
  return async (rawBody: Uint8Array, headers: Headers): Promise<NormalizedMeetingEvent> => {
    const authorization = headers.get('authorization');
    if (!authorization) throw new MeetingProviderError('invalid');

    let claims: JwtPayload;
    try {
      const verified = jwt.verify(authorization.replace(/^Bearer\s+/i, ''), apiSecret, {
        algorithms: ['HS256'],
        issuer: apiKey,
      });
      if (typeof verified === 'string') throw new Error('invalid claims');
      claims = verified;
    } catch {
      throw new MeetingProviderError('invalid');
    }

    const expected = createHash('sha256').update(rawBody).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(String(claims.sha256), 'base64');
    } catch {
      throw new MeetingProviderError('invalid');
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new MeetingProviderError('invalid');
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      throw new MeetingProviderError('invalid');
    }
    const parsed = liveKitWebhookSchema.safeParse(decoded);
    if (!parsed.success) throw new MeetingProviderError('invalid');

    const occurredAt = new Date(parsed.data.createdAt * 1000);
    if (Math.abs(now().getTime() - occurredAt.getTime()) > replayWindowMs) {
      throw new MeetingProviderError('invalid');
    }

    const participantKey = parsed.data.participant?.sid ?? '';
    const fallbackId = createHash('sha256')
      .update(
        `${parsed.data.event}\0${parsed.data.room.name}\0${participantKey}\0${parsed.data.createdAt}`
      )
      .digest('hex');

    return {
      id: parsed.data.id ?? fallbackId,
      type: eventTypes[parsed.data.event as keyof typeof eventTypes] ?? 'unmapped',
      providerType: parsed.data.event,
      roomName: parsed.data.room.name,
      participantId: parsed.data.participant?.sid,
      participantIdentity: parsed.data.participant?.identity,
      occurredAt,
      payload: decoded,
    };
  };
}

export function createLiveKitAdapter(
  options: LiveKitVerifierOptions & {
    getRoomState: (roomName: string) => Promise<ProviderRoomState>;
  }
): MeetingProviderAdapter {
  return {
    kind: 'livekit',
    capabilities: liveKitCapabilities,
    verifyAndNormalizeWebhook: createLiveKitWebhookVerifier(options),
    getRoomState: options.getRoomState,
  };
}
