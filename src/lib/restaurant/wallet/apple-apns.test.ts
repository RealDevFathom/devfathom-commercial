import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { buildAppleApnsJwt, sendApplePassPush } from './apple-apns';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const credentials = {
  privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  keyIdentifier: 'KEYIDENT01',
  teamIdentifier: 'DEVFATH0M1',
  passTypeIdentifier: 'pass.com.devfathom.loyalty',
};

describe('Apple APNs pass pushes', () => {
  it('signs the required ES256 provider token', () => {
    const [header, claims, signature] = buildAppleApnsJwt(
      credentials,
      new Date('2026-08-29T00:00:00Z')
    ).split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEYIDENT01',
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      iss: 'DEVFATH0M1',
      iat: 1787961600,
    });
    expect(Buffer.from(signature!, 'base64url')).toHaveLength(64);
  });

  it('sends an empty data payload and classifies invalid registrations', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 410 }));
    await expect(
      sendApplePassPush({ credentials, pushToken: 'push-token', transport })
    ).rejects.toMatchObject({ invalidPushToken: true, retryable: false, status: 410 });
    expect(transport).toHaveBeenCalledWith(
      'https://api.push.apple.com/3/device/push-token',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        headers: expect.objectContaining({ 'apns-topic': credentials.passTypeIdentifier }),
      })
    );
  });
});
