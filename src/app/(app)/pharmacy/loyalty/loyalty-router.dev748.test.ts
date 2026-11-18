import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  licensed: vi.fn(),
  annotateAudit: vi.fn(),
  managerGate: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
  read: vi.fn(),
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
  revokeLoyaltyCard: mocks.revoke,
  readActiveLoyaltyCard: mocks.read,
}));
// DEV-747: the wallet test passes have their own tests (loyalty-router.dev747.test.ts).
vi.mock('@/lib/pharmacy/loyalty-wallet-pass', () => ({ issuePharmacyWalletTestPasses: vi.fn() }));
import type { TRPCContext } from '@/server/trpc';
import { PharmacyLoyaltyError } from '@/lib/pharmacy/customer-loyalty';
import { pharmacyLoyaltyRouter } from './loyalty-router';

const CODE = 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ';

function caller(role = 'ADMIN') {
  const db = { $transaction: (run: (tx: unknown) => unknown) => run(db) };
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
const issuedAt = new Date('2026-11-15T10:00:00Z');

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
  mocks.revoke.mockResolvedValue({ cardId: 'card-old', reason: 'Stolen' });
});

describe('DEV-748 issuing physical loyalty cards', () => {
  it('lets the owner issue a card and returns its code once, never auditing it', async () => {
    await expect(caller('ADMIN').issueCard(input)).resolves.toEqual({
      cardId: 'card-new',
      issuedAt,
      code: CODE,
      replaced: false,
    });
    expect(mocks.issue).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-a', actorId: 'user-a', branchId: 'branch-a' },
      { customerId: 'customer-a' }
    );
    expect(mocks.managerGate).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.issueCard',
        targetType: 'PharmacyLoyaltyCard',
        targetId: 'card-new',
        metadata: expect.objectContaining({ customerId: 'customer-a', authority: 'OWNER' }),
      })
    );
    expect(JSON.stringify(mocks.annotateAudit.mock.calls)).not.toContain(CODE);
  });

  it('audits a replacement with the old card and the reason', async () => {
    mocks.issue.mockResolvedValue({
      card: { id: 'card-new', issuedAt },
      code: CODE,
      replacedCardId: 'card-old',
      replacedReason: 'Card lost',
    });
    mocks.managerGate.mockResolvedValue({ organizationId: 'org-a', branchId: 'branch-a' });
    await expect(
      caller('MEMBER').issueCard({ ...input, reason: 'Card lost' })
    ).resolves.toMatchObject({ replaced: true });
    expect(mocks.managerGate).toHaveBeenCalledWith(expect.anything(), 'branch-a');
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.replaceCard',
        metadata: expect.objectContaining({
          replacedCardId: 'card-old',
          reason: 'Card lost',
          authority: 'MANAGER',
        }),
      })
    );
  });

  it('refuses a cashier before any card is issued or revoked', async () => {
    mocks.managerGate.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller('MEMBER').issueCard(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller('MEMBER').revokeCard({ ...input, reason: 'Stolen' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('refuses an owner whose administrator access is not confirmed, as a non-manager', async () => {
    mocks.can.mockResolvedValue(false);
    mocks.managerGate.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller('ADMIN').issueCard(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it('explains consent, reason and missing-card refusals', async () => {
    mocks.issue.mockRejectedValueOnce(new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED'));
    await expect(caller().issueCard(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('loyalty consent'),
    });
    mocks.issue.mockRejectedValueOnce(new PharmacyLoyaltyError('LOYALTY_CARD_REASON_REQUIRED'));
    await expect(caller().issueCard(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('reason'),
    });
    mocks.revoke.mockRejectedValueOnce(new PharmacyLoyaltyError('LOYALTY_CARD_NOT_ACTIVE'));
    await expect(caller().revokeCard({ ...input, reason: 'Stolen' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This customer has no working card.',
    });
    mocks.issue.mockRejectedValueOnce(new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND'));
    await expect(caller().issueCard(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('revokes a card with a reason of at least 3 characters and audits it', async () => {
    await expect(caller().revokeCard({ ...input, reason: 'no' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller().revokeCard({ ...input, reason: 'Stolen' })).resolves.toEqual({
      cardId: 'card-old',
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.revokeCard',
        targetId: 'card-old',
        metadata: expect.objectContaining({ reason: 'Stolen', authority: 'OWNER' }),
      })
    );
  });

  it('reads the working card for the owner within the organization', async () => {
    mocks.read.mockResolvedValue({ id: 'card-a', issuedAt });
    await expect(caller().card(input)).resolves.toEqual({ id: 'card-a', issuedAt });
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), 'org-a', 'customer-a');
  });
});
