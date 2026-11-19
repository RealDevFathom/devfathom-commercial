import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-960: only the owner turns "One pharmacist per shift" on or off at a branch, with a fresh
// PIN, and turning it on needs the statement ticked; the accepted text and version are stored.
// Only the owner sees the declared solo sign-offs. Anyone else is refused by the server.
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
  RX_SOLO_SHIFT_DISCLAIMER,
  rxSoloShiftDisclaimerRecord,
} from '@/lib/pharmacy/rx-solo-shift';
import { annotateAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacyRxSoloShiftRouter } from './pharmacy-rx-solo-shift';

const app = router({ pharmacyRxSoloShift: pharmacyRxSoloShiftRouter });

type Role = { key: string; isSystem: boolean } | null;
const OWNER: Role = { key: 'owner', isSystem: true };

function fixture(
  role: Role,
  options: { support?: boolean; stored?: { enabled: boolean; version: number } | null } = {}
) {
  const writes: Array<{ text: string; values: unknown[] }> = [];
  const locks: string[] = [];
  let stored = options.stored ?? null;
  const queryRaw = vi.fn(async (query: { strings: string[]; values: unknown[] }) => {
    const text = query.strings.join('?');
    if (text.includes('pg_advisory_xact_lock')) {
      locks.push(text);
      return [{ locked: '' }];
    }
    if (text.includes('INSERT INTO "pharmacy_rx_solo_shift_policy_changes"')) {
      writes.push({ text, values: query.values });
      stored = { enabled: query.values[2] as boolean, version: (stored?.version ?? 0) + 1 };
      return [stored];
    }
    if (text.includes('DISTINCT ON ("branchId")'))
      return stored
        ? [{ branchId: 'branch-1', ...stored, changedAt: new Date(0), actorUserId: 'user-1' }]
        : [];
    if (text.includes('FROM "pharmacy_rx_solo_shift_policy_changes"') && text.includes('LIMIT 1'))
      return stored ? [stored] : [];
    return [];
  });
  const db = {
    $queryRaw: queryRaw,
    $transaction: async (callback: (tx: unknown) => unknown) => callback(db),
    pharmacyBranch: {
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id === 'branch-1' ? { id: 'branch-1' } : null
      ),
      findMany: vi.fn(async () => [{ id: 'branch-1', name: 'Main', code: 'MAIN' }]),
    },
    auditLog: { findMany: vi.fn(async () => []) },
    user: {
      findFirst: vi.fn(async () => ({
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
      })),
      findMany: vi.fn(async () => [{ id: 'user-1', name: 'Owner' }]),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'user-1',
        role: 'ADMIN',
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
  return { db, writes, locks, caller: app.createCaller(context).pharmacyRxSoloShift };
}

const turnOn = {
  branchId: 'branch-1',
  enabled: true,
  expectedVersion: 0,
  pin: '2468',
  disclaimer: { accepted: true, version: RX_SOLO_SHIFT_DISCLAIMER.version },
};

beforeEach(() => {
  vi.mocked(verifyOwnerExportPin).mockReset();
  vi.mocked(verifyOwnerExportPin).mockResolvedValue('OK');
  vi.mocked(annotateAudit).mockClear();
});

describe('pharmacyRxSoloShift.setPolicy', () => {
  it('lets the owner turn it on at a branch with a fresh PIN and the statement, and stores the text', async () => {
    const f = fixture(OWNER);
    await expect(f.caller.setPolicy(turnOn)).resolves.toEqual({
      changed: true,
      enabled: true,
      version: 1,
    });
    expect(verifyOwnerExportPin).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
      pin: '2468',
      action: 'pharmacy.rxSoloShiftPolicy',
    });
    expect(f.writes).toHaveLength(1);
    // The append-only row stores the branch, the statement version and the exact text accepted.
    expect(f.writes[0]!.values).toEqual(
      expect.arrayContaining([
        'org-1',
        'branch-1',
        true,
        RX_SOLO_SHIFT_DISCLAIMER.version,
        rxSoloShiftDisclaimerRecord(),
        'user-1',
      ])
    );
    // The write holds the branch's setting lock exclusively.
    expect(f.locks.some((text) => text.includes('pg_advisory_xact_lock('))).toBe(true);
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          pinVerified: true,
          acceptedDisclaimer: rxSoloShiftDisclaimerRecord(),
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
    await expect(f.caller.setPolicy(turnOn)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyOwnerExportPin).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
  });

  it('refuses a support session even for the owner', async () => {
    const f = fixture(OWNER, { support: true });
    await expect(f.caller.setPolicy(turnOn)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.writes).toHaveLength(0);
  });

  it('refuses a branch of another organization or one that does not exist', async () => {
    const f = fixture(OWNER);
    await expect(
      f.caller.setPolicy({ ...turnOn, branchId: 'branch-elsewhere' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(verifyOwnerExportPin).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
  });

  it('refuses the owner without the PIN, or with a wrong or locked PIN', async () => {
    const f = fixture(OWNER);
    await expect(f.caller.setPolicy({ ...turnOn, pin: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    vi.mocked(verifyOwnerExportPin).mockResolvedValueOnce('REJECTED');
    await expect(f.caller.setPolicy(turnOn)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    vi.mocked(verifyOwnerExportPin).mockResolvedValueOnce('LOCKED');
    await expect(f.caller.setPolicy(turnOn)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    vi.mocked(verifyOwnerExportPin).mockResolvedValueOnce('NO_PIN');
    await expect(f.caller.setPolicy(turnOn)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(f.writes).toHaveLength(0);
  });

  it('refuses to turn it on unless the current statement is ticked', async () => {
    const f = fixture(OWNER);
    await expect(f.caller.setPolicy({ ...turnOn, disclaimer: undefined })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      f.caller.setPolicy({ ...turnOn, disclaimer: { ...turnOn.disclaimer, accepted: false } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      f.caller.setPolicy({
        ...turnOn,
        disclaimer: { accepted: true, version: 'rx-solo-shift-on@0' },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The statement has changed. Reload, read it again and tick it.',
    });
    expect(f.writes).toHaveLength(0);
  });

  it('refuses a stale version and changes nothing when asked for the state in force', async () => {
    const f = fixture(OWNER, { stored: { enabled: false, version: 2 } });
    await expect(f.caller.setPolicy({ ...turnOn, expectedVersion: 1 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(f.writes).toHaveLength(0);
    vi.mocked(verifyOwnerExportPin).mockClear();
    const off = fixture(OWNER);
    await expect(
      off.caller.setPolicy({ branchId: 'branch-1', enabled: false, expectedVersion: 0, pin: '' })
    ).resolves.toEqual({ changed: false, enabled: false, version: 0 });
    expect(verifyOwnerExportPin).not.toHaveBeenCalled();
    expect(off.writes).toHaveLength(0);
  });

  it('lets the owner turn it off with the PIN and no statement', async () => {
    const f = fixture(OWNER, { stored: { enabled: true, version: 1 } });
    await expect(
      f.caller.setPolicy({ branchId: 'branch-1', enabled: false, expectedVersion: 1, pin: '2468' })
    ).resolves.toEqual({ changed: true, enabled: false, version: 2 });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.values).toEqual(
      expect.arrayContaining(['org-1', 'branch-1', false, null, 'user-1'])
    );
  });
});

describe('pharmacyRxSoloShift reads', () => {
  it('shows the branches only to the owner, off by default', async () => {
    await expect(fixture({ key: 'pharmacist', isSystem: true }).caller.overview()).resolves.toEqual(
      { canManage: false, branches: [], disclaimerVersion: RX_SOLO_SHIFT_DISCLAIMER.version }
    );
    await expect(fixture(OWNER).caller.overview()).resolves.toEqual({
      canManage: true,
      disclaimerVersion: RX_SOLO_SHIFT_DISCLAIMER.version,
      branches: [
        {
          branchId: 'branch-1',
          branchName: 'Main',
          branchCode: 'MAIN',
          enabled: false,
          version: 0,
          source: 'DEFAULT',
          updatedAt: null,
          updatedByName: null,
        },
      ],
    });
  });

  it('keeps the change history and the declared sign-offs for the owner only', async () => {
    for (const role of [
      { key: 'manager', isSystem: true },
      { key: 'pharmacist', isSystem: true },
    ]) {
      const f = fixture(role);
      await expect(f.caller.history()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(f.caller.declaredSignOffs()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.auditLog.findMany).not.toHaveBeenCalled();
    }
    const owner = fixture(OWNER);
    await expect(owner.caller.history()).resolves.toEqual([]);
    await expect(owner.caller.declaredSignOffs()).resolves.toEqual([]);
    // Only declared, successful self-sign entries on a review are read.
    expect(owner.db.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          action: 'pharmacyDispensing.selfSignReview',
          outcome: 'SUCCESS',
          targetType: 'PharmacyPharmacistReviewItem',
          AND: expect.arrayContaining([{ metadata: { path: ['declaredSolo'], equals: true } }]),
        }),
      })
    );
  });
});
