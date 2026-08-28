import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createLiveKitAdapter, createLiveKitWebhookVerifier } from './livekit';

const API_KEY = 'test-key';
const API_SECRET = 'test-secret-long-enough-for-tests';
const NOW = new Date('2026-08-28T04:00:00.000Z');

function signed(body: Uint8Array) {
  const sha256 = createHash('sha256').update(body).digest('base64');
  return jwt.sign({ sha256 }, API_SECRET, {
    algorithm: 'HS256',
    issuer: API_KEY,
    expiresIn: '5m',
  });
}

function event(overrides: Record<string, unknown> = {}) {
  return new TextEncoder().encode(
    JSON.stringify({
      id: 'event-1',
      event: 'participant_joined',
      createdAt: NOW.getTime() / 1000,
      room: { name: 'mtg_random' },
      participant: { sid: 'PA_1', identity: 'grant_1' },
      ...overrides,
    })
  );
}

describe('LiveKit raw webhook verification', () => {
  const verify = createLiveKitWebhookVerifier({
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    now: () => NOW,
  });

  it('verifies the raw bytes before normalizing provider vocabulary', async () => {
    const body = event();
    const result = await verify(body, new Headers({ authorization: signed(body) }));
    expect(result).toMatchObject({
      id: 'event-1',
      type: 'participant.joined',
      roomName: 'mtg_random',
      participantId: 'PA_1',
      participantIdentity: 'grant_1',
    });
  });

  it('rejects a valid token when even semantically equivalent body bytes differ', async () => {
    const original = event();
    const changed = new TextEncoder().encode(`${new TextDecoder().decode(original)} `);
    await expect(
      verify(changed, new Headers({ authorization: signed(original) }))
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it.each([
    ['missing signature', undefined],
    ['wrong secret', jwt.sign({ sha256: 'nope' }, 'wrong-secret', { issuer: API_KEY })],
  ])('rejects %s without parsing or exposing detail', async (_label, authorization) => {
    const headers = new Headers(authorization ? { authorization } : undefined);
    await expect(verify(event(), headers)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects stale signed events before ingestion', async () => {
    const body = event({ createdAt: (NOW.getTime() - 11 * 60 * 1000) / 1000 });
    await expect(verify(body, new Headers({ authorization: signed(body) }))).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('records unknown provider event types as unmapped instead of guessing', async () => {
    const body = event({ event: 'track_published' });
    await expect(verify(body, new Headers({ authorization: signed(body) }))).resolves.toMatchObject(
      {
        type: 'unmapped',
        providerType: 'track_published',
      }
    );
  });

  it('exposes room-state/drain checks through the provider-neutral contract', async () => {
    const getRoomState = vi.fn(async () => ({ exists: true, active: false, participants: [] }));
    const adapter = createLiveKitAdapter({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      now: () => NOW,
      getRoomState,
    });
    expect(adapter.kind).toBe('livekit');
    expect(adapter.capabilities.webhooks).toBe('signed-at-least-once');
    await expect(adapter.getRoomState('mtg_random')).resolves.toMatchObject({ active: false });
  });
});
