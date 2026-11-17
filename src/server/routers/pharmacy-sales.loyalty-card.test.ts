import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-748: scanning a physical loyalty card at the counter links its customer to the open bill.
// It uses the counter's member, capability and branch-assignment gate, and the card code (a
// bearer token) never reaches the audit log.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
const audit = vi.hoisted(() => ({ annotate: vi.fn(), record: vi.fn() }));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  annotateAudit: audit.annotate,
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: audit.record,
}));
vi.mock('@/lib/pharmacy/loyalty-card', () => ({ linkLoyaltyCardToSale: vi.fn() }));

import { PharmacyLoyaltyError } from '@/lib/pharmacy/customer-loyalty';
import { linkLoyaltyCardToSale } from '@/lib/pharmacy/loyalty-card';
import { toAuditJson } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const BRANCH = 'branch-main';
const CARD = 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ';
const scan = { branchId: BRANCH, saleId: 'sale-1', cardToken: CARD };

function fixture(options: { capabilities: string[]; assignedBranches: string[] }) {
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id ? where.id.in.map((id) => ({ id })) : []
      ),
      findFirst: vi.fn(async () => ({ id: BRANCH })),
    },
    organization: { findUnique: vi.fn(async () => ({ currency: 'PKR', timezone: null })) },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => options.assignedBranches.map((branchId) => ({ branchId }))),
    },
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: options.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
        },
        permissionOverrides: [],
      })),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DEV-748 counter loyalty card scan', () => {
  it('links the card holder to the bill for a cashier assigned to the branch', async () => {
    const { caller } = fixture({ capabilities: ['pharmacy:counter'], assignedBranches: [BRANCH] });
    vi.mocked(linkLoyaltyCardToSale).mockResolvedValue({
      cardId: 'card-1',
      customerId: 'customer-1',
      displayName: 'Ayesha',
    });
    await expect(caller.scanLoyaltyCard(scan)).resolves.toEqual({
      id: 'customer-1',
      displayName: 'Ayesha',
    });
    expect(vi.mocked(linkLoyaltyCardToSale).mock.calls[0]!.slice(1)).toEqual([
      { organizationId: 'org-1', branchId: BRANCH, actorId: 'cashier-1' },
      { saleId: 'sale-1', code: CARD },
    ]);
    expect(audit.annotate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'pharmacyLoyalty.scanCard',
        targetId: 'sale-1',
        metadata: { branchId: BRANCH, cardId: 'card-1', customerId: 'customer-1' },
      })
    );
    expect(JSON.stringify(audit.annotate.mock.calls)).not.toContain(CARD);
  });

  it('never records the card code in the audit input, even when the scan is refused', async () => {
    const { caller } = fixture({ capabilities: ['pharmacy:counter'], assignedBranches: [] });
    await expect(caller.scanLoyaltyCard(scan)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(linkLoyaltyCardToSale).not.toHaveBeenCalled();
    const recorded = audit.record.mock.calls.at(-1)![0] as { input: unknown };
    expect(JSON.stringify(toAuditJson(recorded.input))).not.toContain(CARD);
    expect(toAuditJson(recorded.input)).toMatchObject({ cardToken: '[REDACTED]' });
  });

  it('refuses a member without a counter capability before any lookup', async () => {
    const { caller } = fixture({
      capabilities: ['pharmacy:inventory'],
      assignedBranches: [BRANCH],
    });
    await expect(caller.scanLoyaltyCard(scan)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(linkLoyaltyCardToSale).not.toHaveBeenCalled();
  });

  it('answers an unknown, revoked or other-organization card as not found', async () => {
    const { caller } = fixture({ capabilities: ['pharmacy:counter'], assignedBranches: [BRANCH] });
    vi.mocked(linkLoyaltyCardToSale).mockRejectedValue(
      new PharmacyLoyaltyError('LOYALTY_CARD_NOT_RECOGNISED')
    );
    await expect(caller.scanLoyaltyCard(scan)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'LOYALTY_CARD_NOT_RECOGNISED',
    });
    expect(audit.annotate).not.toHaveBeenCalled();
  });
});
