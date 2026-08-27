import { describe, expect, test } from 'vitest';

import {
  generateCameraGatewaySecret,
  gatewayHealth,
  hashCameraGatewaySecret,
  isCameraGatewaySecretFormat,
  isCameraGatewayUsable,
} from './cameras';

describe('camera gateway trust primitives', () => {
  test('mints a 256-bit rcg secret and deterministic SHA-256 hash', () => {
    const minted = generateCameraGatewaySecret();
    expect(isCameraGatewaySecretFormat(minted.secret)).toBe(true);
    expect(minted.secretHash).toBe(hashCameraGatewaySecret(minted.secret));
    expect(minted.secretHash).toHaveLength(64);
  });

  test('revoked gateways are unusable and always report revoked', () => {
    const gateway = { status: 'REVOKED' as const, revokedAt: new Date(), lastSeenAt: new Date() };
    expect(isCameraGatewayUsable(gateway)).toBe(false);
    expect(gatewayHealth(gateway, new Date())).toBe('REVOKED');
  });
});
