/**
 * D19 — an anonymous, token-bearing request resolves its tenant from the token,
 * because both token hashes are globally unique. A caller without a valid token
 * resolves to nothing, so this opens no new surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  invitationFindUnique: vi.fn(),
  resetFindUnique: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) =>
    run({
      invitation: { findUnique: mocks.invitationFindUnique },
      passwordResetToken: { findUnique: mocks.resetFindUnique },
    })
  ),
}));

import { organizationForAnonymousToken } from './anonymous-tenant';

const TOKEN = 'a'.repeat(43);
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

describe('organizationForAnonymousToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invitationFindUnique.mockResolvedValue(null);
    mocks.resetFindUnique.mockResolvedValue(null);
  });

  it('resolves an invitation token to its organization', async () => {
    mocks.invitationFindUnique.mockResolvedValue({ organizationId: 'org_1' });

    await expect(organizationForAnonymousToken(TOKEN)).resolves.toBe('org_1');
    expect(mocks.invitationFindUnique).toHaveBeenCalledWith({
      where: { tokenHash: TOKEN_HASH },
      select: { organizationId: true },
    });
  });

  it('resolves a password-reset token to its organization', async () => {
    mocks.resetFindUnique.mockResolvedValue({ organizationId: 'org_2' });

    await expect(organizationForAnonymousToken(TOKEN)).resolves.toBe('org_2');
  });

  it('looks up only by the token hash, never by anything caller-supplied', async () => {
    await organizationForAnonymousToken(TOKEN);

    for (const call of [
      ...mocks.invitationFindUnique.mock.calls,
      ...mocks.resetFindUnique.mock.calls,
    ]) {
      const [args] = call as [{ where: Record<string, unknown>; select: Record<string, unknown> }];
      expect(Object.keys(args.where)).toEqual(['tokenHash']);
      expect(args.select).toEqual({ organizationId: true });
    }
  });

  it('resolves nothing for an unknown token', async () => {
    await expect(organizationForAnonymousToken(TOKEN)).resolves.toBeNull();
  });

  it.each([[null], [undefined], [''], ['short'], ['x'.repeat(600)]])(
    'refuses the malformed token %j without querying',
    async (token) => {
      await expect(organizationForAnonymousToken(token)).resolves.toBeNull();
      expect(mocks.invitationFindUnique).not.toHaveBeenCalled();
      expect(mocks.resetFindUnique).not.toHaveBeenCalled();
    }
  );
});
