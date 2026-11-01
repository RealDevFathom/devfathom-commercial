import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ctx } = vi.hoisted(() => ({
  ctx: {
    state: 'UNLOCKED',
    organizationId: 'org-1',
    device: { id: 'device-1', branchId: 'branch-1' },
    session: { id: 'replacement-session', activeStaffProfileId: 'staff-1' as string | null },
  },
}));

vi.mock('@/lib/restaurant/terminal-auth', () => ({
  withTerminalAuth:
    (handler: (context: typeof ctx, request: Request) => Promise<Response>) => (request: Request) =>
      handler(ctx, request),
}));

import { mintPosComposerProof, verifyPosComposerProof } from '@/lib/restaurant/pos-composer-proof';
import { POST } from './route';

const originalClaims = {
  organizationId: 'org-1',
  branchId: 'branch-1',
  deviceId: 'device-1',
  sessionId: 'original-session',
  staffProfileId: 'staff-1',
};

function renew(originalProof: string) {
  return POST(
    new Request('https://tenant.test/api/restaurant/terminal/renew-composer-proof', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalProof }),
    })
  );
}

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'test-composer-renewal-secret');
  ctx.state = 'UNLOCKED';
  ctx.session.activeStaffProfileId = 'staff-1';
});
afterEach(() => vi.unstubAllEnvs());

describe('composer proof renewal', () => {
  it('renews an expired draft after session replacement and binds commands to the new session', async () => {
    const proof = mintPosComposerProof(originalClaims, new Date(Date.now() - 2 * 86_400_000));
    const expected = { ...originalClaims, sessionId: ctx.session.id };
    expect(verifyPosComposerProof(proof, expected)).toBe(false);

    const response = await renew(proof);
    expect(response.status).toBe(200);
    const { composerProof } = await response.json();
    expect(verifyPosComposerProof(composerProof, expected)).toBe(true);
    expect(verifyPosComposerProof(composerProof, originalClaims)).toBe(false);
  });

  it.each(['organizationId', 'branchId', 'deviceId', 'staffProfileId'] as const)(
    'rejects a proof belonging to another %s',
    async (claim) => {
      const proof = mintPosComposerProof({ ...originalClaims, [claim]: 'someone-else' });
      expect((await renew(proof)).status).toBe(403);
    }
  );

  it('rejects an unsigned change to the composing operator', async () => {
    const proof = mintPosComposerProof({ ...originalClaims, staffProfileId: 'staff-2' });
    const [version, payload, signature] = proof.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.staffProfileId = 'staff-1';
    const tampered = `${version}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
    expect((await renew(tampered)).status).toBe(403);
  });

  it.each(['locked', 'no operator'])(
    'requires an unlocked authenticated operator (%s)',
    async (state) => {
      if (state === 'locked') ctx.state = 'LOCKED';
      else ctx.session.activeStaffProfileId = null;
      expect((await renew(mintPosComposerProof(originalClaims))).status).toBe(403);
    }
  );
});
