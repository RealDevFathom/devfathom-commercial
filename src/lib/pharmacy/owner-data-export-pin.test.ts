// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  withTenantDb: vi.fn(),
  queryRaw: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
}));

// DEV-879: these fixtures model an approver with no approval authenticator, so the PIN is
// checked exactly as before. approval-authenticator.test.ts covers the authenticator path.
vi.mock('@/lib/approval-authenticator', async () => {
  const { verifyOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  return {
    verifyApprovalSecret: async (
      _db: unknown,
      input: { secret: string; credentialHash: string }
    ) =>
      (await verifyOperatorCredential('PIN', input.secret, input.credentialHash)) ? 'PIN' : null,
  };
});
vi.mock('@/lib/restaurant/operator-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: m.verify,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: m.withTenantDb }));

import { MAX_FAILED_ATTEMPTS } from '@/lib/restaurant/operator-credentials';
import { readOwnerExportPin, verifyOwnerExportPin } from './owner-data-export-pin';

const NOW = new Date('2026-11-15T10:00:00.000Z');
const input = { organizationId: 'org-a', userId: 'u-owner', pin: '2468' };
const credential = (state: Partial<{ failedAttempts: number; lockedUntil: Date | null }> = {}) => ({
  id: 'cred-1',
  credentialHash: 'hash',
  failedAttempts: 0,
  lockedUntil: null,
  ...state,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.withTenantDb.mockImplementation(async (_org: string, run: (tx: unknown) => unknown) =>
    run({
      $queryRaw: m.queryRaw,
      restaurantOperatorCredential: { findFirst: m.findFirst, update: m.update },
    })
  );
  m.queryRaw.mockResolvedValue([]);
  m.update.mockResolvedValue({});
});

describe('verifyOwnerExportPin', () => {
  it("checks only the signed-in owner's own active PIN in this organization, under a row lock", async () => {
    m.findFirst.mockResolvedValue(credential());
    m.verify.mockResolvedValue(true);
    expect(await verifyOwnerExportPin(input, NOW)).toBe('OK');
    expect(m.withTenantDb).toHaveBeenCalledWith(
      'org-a',
      expect.any(Function),
      expect.objectContaining({ userId: 'u-owner', skipDrain: true })
    );
    expect(m.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      m.findFirst.mock.invocationCallOrder[0]!
    );
    expect(m.findFirst.mock.calls[0]![0].where).toEqual({
      organizationId: 'org-a',
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: { organizationId: 'org-a', userId: 'u-owner', status: 'ACTIVE' },
    });
    expect(m.verify).toHaveBeenCalledWith('PIN', '2468', 'hash');
    expect(m.update).toHaveBeenCalledWith({
      where: { id: 'cred-1' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  });

  it('strikes the shared lockout counter for a wrong PIN', async () => {
    m.findFirst.mockResolvedValue(credential({ failedAttempts: 1 }));
    m.verify.mockResolvedValue(false);
    expect(await verifyOwnerExportPin(input, NOW)).toBe('REJECTED');
    expect(m.update).toHaveBeenCalledWith({
      where: { id: 'cred-1' },
      data: { failedAttempts: 2, lockedUntil: null },
    });
  });

  it('locks the PIN on the last allowed wrong guess', async () => {
    m.findFirst.mockResolvedValue(credential({ failedAttempts: MAX_FAILED_ATTEMPTS - 1 }));
    m.verify.mockResolvedValue(false);
    expect(await verifyOwnerExportPin(input, NOW)).toBe('LOCKED');
    const data = m.update.mock.calls[0]![0].data;
    expect(data.lockedUntil.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('refuses a locked PIN without testing the guess, even a correct one', async () => {
    m.findFirst.mockResolvedValue(
      credential({ lockedUntil: new Date(NOW.getTime() + 60_000), failedAttempts: 0 })
    );
    m.verify.mockResolvedValue(true);
    expect(await verifyOwnerExportPin(input, NOW)).toBe('LOCKED');
    expect(m.verify).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  it('reports an owner with no PIN', async () => {
    m.findFirst.mockResolvedValue(null);
    expect(await verifyOwnerExportPin(input, NOW)).toBe('NO_PIN');
    expect(m.verify).not.toHaveBeenCalled();
  });
});

describe('readOwnerExportPin', () => {
  it('takes the PIN exactly as typed and refuses missing or oversized values', () => {
    expect(readOwnerExportPin('2468')).toBe('2468');
    expect(readOwnerExportPin(' 2468')).toBe(' 2468');
    for (const value of [undefined, null, '', 2468, 'x'.repeat(65)]) {
      expect(readOwnerExportPin(value)).toBeNull();
    }
  });
});
