import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { mintPosComposerProof, verifyPosComposerProof } from './pos-composer-proof';

const claims = {
  organizationId: 'org-1',
  branchId: 'branch-1',
  deviceId: 'device-1',
  sessionId: 'session-1',
  staffProfileId: 'staff-a',
};

describe('POS composer proofs', () => {
  beforeEach(() => vi.stubEnv('AUTH_SECRET', 'test-pos-composer-secret'));

  it('binds an offline composer to the authenticated tenant, device, session, and operator', () => {
    const now = new Date('2026-10-26T12:00:00.000Z');
    const proof = mintPosComposerProof(claims, now);

    expect(verifyPosComposerProof(proof, claims, now)).toBe(true);
    expect(
      verifyPosComposerProof(proof, { ...claims, staffProfileId: 'staff-b' }, now)
    ).toBe(false);
    expect(verifyPosComposerProof(proof, { ...claims, deviceId: 'device-2' }, now)).toBe(false);
  });

  it('rejects browser-side tampering and expired proofs', () => {
    const issued = new Date('2026-10-26T12:00:00.000Z');
    const proof = mintPosComposerProof(claims, issued);
    const parts = proof.split('.');
    const changedPayload = Buffer.from(
      JSON.stringify({
        ...claims,
        staffProfileId: 'staff-b',
        expiresAt: issued.getTime() + 86_400_000,
      })
    ).toString('base64url');

    expect(verifyPosComposerProof(`${parts[0]}.${changedPayload}.${parts[2]}`, claims, issued)).toBe(
      false
    );
    expect(verifyPosComposerProof(proof, claims, new Date('2026-10-28T12:00:00.000Z'))).toBe(false);
  });
});
