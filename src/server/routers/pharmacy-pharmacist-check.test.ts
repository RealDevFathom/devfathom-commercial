import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-911: only the owner changes the pharmacist check at each sale, with a fresh PIN, and
// turning it off needs the disclaimer ticked. Anyone else is refused by the server.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/owner-data-export-pin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/owner-data-export-pin')>()),
  verifyOwnerExportPin: vi.fn(),
}));

import { verifyOwnerExportPin } from '@/lib/pharmacy/owner-data-export-pin';
import {
  PHARMACIST_CHECK_DISCLAIMER,
  pharmacistCheckDisclaimerRecord,
} from '@/lib/pharmacy/pharmacist-check';
import { annotateAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacyPharmacistCheckRouter } from './pharmacy-pharmacist-check';

const app = router({ pharmacyPharmacistCheck: pharmacyPharmacistCheckRouter });

type Role = { key: string; isSystem: boolean } | null;
const OWNER: Role = { key: 'owner', isSystem: true };

function fixture(role: Role, options: { support?: boolean; userRole?: string } = {}) {
  const writes: Array<{ text: string; values: unknown[] }> = [];
  const queryRaw = vi.fn(async (query: { strings: string[]; values: unknown[] }) => {
    const text = query.strings.join('?');
    if (text.includes('INSERT INTO "pharmacy_owner_policies"')) {
      writes.push({ text, values: query.values });
      return [{ enabled: query.values[1], version: 1 }];
    }
    if (text.includes('UPDATE "pharmacy_owner_policies"')) {
      writes.push({ text, values: query.values });
      return [{ enabled: query.values[0], version: 2 }];
    }
    if (text.includes('"pharmacy_owner_policy_audit"')) return [];
    return [];
  });
  const db = {
    $queryRaw: queryRaw,
    $transaction: async (callback: (tx: unknown) => unknown) => callback(db),
    pharmacyOwnerPolicy: { findUnique: vi.fn(async () => null) },
    user: {
      findUnique: async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions: [{ capability: '*', effect: 'ALLOW' }] },
        permissionOverrides: [],
      }),
      findFirst: vi.fn(async (args: { select?: { name?: boolean } }) =>
        args.select?.name
          ? { name: 'Owner' }
          : {
              id: 'user-1',
              organizationId: 'org-1',
              status: 'ACTIVE',
              organizationRole: role
                ? {
                    ...role,
                    organizationId: 'org-1',
                    permissions: [{ capability: '*', effect: 'ALLOW' }],
                  }
                : null,
              permissionOverrides: [],
            }
      ),
      findMany: vi.fn(async () => []),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'user-1',
        role: options.userRole ?? 'ADMIN',
        status: 'ACTIVE',
        organizationId: 'org-1',
        isSupportSession: options.support ?? false,
      },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, writes, caller: app.createCaller(context).pharmacyPharmacistCheck };
}

const turnOff = {
  enabled: false,
  expectedVersion: 0,
  pin: '2468',
  disclaimer: { accepted: true, version: PHARMACIST_CHECK_DISCLAIMER.version },
};

beforeEach(() => {
  vi.mocked(verifyOwnerExportPin).mockReset();
  vi.mocked(verifyOwnerExportPin).mockResolvedValue('OK');
  vi.mocked(annotateAudit).mockClear();
});

describe('pharmacyPharmacistCheck.setPolicy', () => {
  it('lets the owner turn the check off with a fresh PIN and the disclaimer, and audits the text', async () => {
    const f = fixture(OWNER);
    await expect(f.caller.setPolicy(turnOff)).resolves.toMatchObject({
      changed: true,
      policy: { enabled: false, version: 1, source: 'STORED' },
    });
    expect(verifyOwnerExportPin).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
      pin: '2468',
      action: 'pharmacy.pharmacistCheckPolicy',
    });
    // The policy row (and its trigger-written audit row) stores the accepted disclaimer.
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.values).toContain(pharmacistCheckDisclaimerRecord());
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          acceptedDisclaimer: pharmacistCheckDisclaimerRecord(),
        }),
      })
    );
    // The PIN never reaches the audit row.
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skipInput: true })
    );
  });

  it.each<[string, Role]>([
    ['a manager', { key: 'manager', isSystem: true }],
    ['a pharmacist', { key: 'pharmacist', isSystem: true }],
    ['a cashier', { key: 'cashier', isSystem: true }],
    ['an admin without the owner role', null],
  ])('refuses %s, before any PIN check or write', async (_label, role) => {
    const f = fixture(role);
    await expect(f.caller.setPolicy(turnOff)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      f.caller.setPolicy({ enabled: true, expectedVersion: 1, pin: '2468' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyOwnerExportPin).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
  });

  it('refuses a support session even for the owner', async () => {
    const f = fixture(OWNER, { support: true });
    await expect(f.caller.setPolicy(turnOff)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.writes).toHaveLength(0);
  });

  it('refuses the owner without the PIN, or with a wrong or locked PIN', async () => {
    const f = fixture(OWNER);
    await expect(f.caller.setPolicy({ ...turnOff, pin: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    vi.mocked(verifyOwnerExportPin).mockResolvedValueOnce('REJECTED');
    await expect(f.caller.setPolicy(turnOff)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    vi.mocked(verifyOwnerExportPin).mockResolvedValueOnce('LOCKED');
    await expect(f.caller.setPolicy(turnOff)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    vi.mocked(verifyOwnerExportPin).mockResolvedValueOnce('NO_PIN');
    await expect(f.caller.setPolicy(turnOff)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(f.writes).toHaveLength(0);
  });

  it('refuses to turn the check off unless the disclaimer is ticked', async () => {
    const f = fixture(OWNER);
    const withoutDisclaimer = { enabled: false, expectedVersion: 0, pin: '2468' };
    await expect(f.caller.setPolicy(withoutDisclaimer)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      f.caller.setPolicy({ ...turnOff, disclaimer: { ...turnOff.disclaimer, accepted: false } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.writes).toHaveLength(0);
  });

  it('lets the owner turn it back on with the PIN and no disclaimer', async () => {
    const f = fixture(OWNER);
    f.db.$queryRaw.mockImplementationOnce(async () => []); // user FOR SHARE lock
    f.db.$queryRaw.mockImplementationOnce(async () => [{ enabled: false, version: 1 }]);
    await expect(
      f.caller.setPolicy({ enabled: true, expectedVersion: 1, pin: '2468' })
    ).resolves.toMatchObject({ changed: true, policy: { enabled: true } });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.text).toContain('UPDATE "pharmacy_owner_policies"');
  });
});

describe('pharmacyPharmacistCheck.policy', () => {
  it('shows every member the state, and only the owner may manage it', async () => {
    await expect(fixture({ key: 'cashier', isSystem: true }).caller.policy()).resolves.toEqual({
      policy: {
        enabled: true,
        version: 0,
        source: 'DEFAULT',
        updatedAt: null,
        updatedByName: null,
      },
      canManage: false,
      disclaimerVersion: PHARMACIST_CHECK_DISCLAIMER.version,
    });
    await expect(fixture(OWNER).caller.policy()).resolves.toMatchObject({ canManage: true });
  });

  it('keeps the change history for the owner only', async () => {
    await expect(
      fixture({ key: 'manager', isSystem: true }).caller.history()
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fixture(OWNER).caller.history()).resolves.toEqual([]);
  });
});
