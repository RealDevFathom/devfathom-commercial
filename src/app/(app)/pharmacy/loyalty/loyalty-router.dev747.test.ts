import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  licensed: vi.fn(),
  annotateAudit: vi.fn(),
  managerGate: vi.fn(),
  issue: vi.fn(),
  wallet: vi.fn(),
  inTransaction: { current: false },
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.licensed,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
}));
vi.mock('@/server/routers/pharmacy-sales', () => ({
  requireDrawerManagerAccess: mocks.managerGate,
}));
vi.mock('@/lib/pharmacy/loyalty-card', () => ({
  issueLoyaltyCard: mocks.issue,
  revokeLoyaltyCard: vi.fn(),
  readActiveLoyaltyCard: vi.fn(),
}));
vi.mock('@/lib/pharmacy/loyalty-wallet-pass', () => ({
  issuePharmacyWalletTestPasses: mocks.wallet,
}));
import type { TRPCContext } from '@/server/trpc';
import { PharmacyLoyaltyError } from '@/lib/pharmacy/customer-loyalty';
import { pharmacyLoyaltyRouter } from './loyalty-router';

const CODE = 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TX = { tx: true };
const PASSES = { mode: 'TEST', balancePoints: 900, pointValueMinor: 100 };

function caller(role = 'ADMIN') {
  const db = {
    $transaction: async (run: (tx: unknown) => unknown) => {
      mocks.inTransaction.current = true;
      try {
        return await run(TX);
      } finally {
        mocks.inTransaction.current = false;
      }
    },
  };
  return pharmacyLoyaltyRouter.createCaller({
    db,
    session: {
      expires: 'later',
      user: { id: 'user-a', organizationId: 'org-a', role, status: 'ACTIVE' },
    },
    entitlements: { organizationId: 'org-a', modules: [], enabledModules: ['pharmacy-crm'] },
    organization: { id: 'org-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const input = { branchId: 'branch-a', customerId: 'customer-a' };
const issuedAt = new Date('2026-11-18T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.licensed.mockReturnValue(true);
  mocks.issue.mockResolvedValue({
    card: { id: 'card-new', issuedAt },
    code: CODE,
    replacedCardId: null,
    replacedReason: null,
  });
  mocks.wallet.mockImplementation(async () => {
    if (!mocks.inTransaction.current) throw new Error('built outside the issuing transaction');
    return PASSES;
  });
});

describe('DEV-747 wallet test passes for a pharmacy loyalty card', () => {
  it('returns the new card as wallet test passes, built in the issuing transaction', async () => {
    await expect(caller().issueCard(input)).resolves.toEqual({
      cardId: 'card-new',
      issuedAt,
      code: CODE,
      replaced: false,
      walletTestPasses: PASSES,
    });
    // The same code as the printed card, for the same customer, read with the same transaction.
    expect(mocks.wallet).toHaveBeenCalledWith(TX, 'org-a', {
      customerId: 'customer-a',
      code: CODE,
    });
    expect(JSON.stringify(mocks.annotateAudit.mock.calls)).not.toContain(CODE);
  });

  it('builds no pass when the card is refused', async () => {
    mocks.issue.mockRejectedValueOnce(new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED'));
    await expect(caller().issueCard(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    mocks.managerGate.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller('MEMBER').issueCard(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('issues no card when the passes cannot be built, so no code is lost unprinted', async () => {
    mocks.wallet.mockRejectedValueOnce(new Error('Invalid wallet pass balance.'));
    await expect(caller().issueCard(input)).rejects.toThrow('Invalid wallet pass balance.');
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });
});
