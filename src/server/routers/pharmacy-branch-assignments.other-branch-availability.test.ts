import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-907: the owner alone turns the counter's "also in stock at another branch"
// line on or off. The switch is off by default, read from the stored
// organization, and every change is audited.
vi.mock('server-only', () => ({}));
const audit = vi.hoisted(() => ({ annotateAudit: vi.fn() }));
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    recordTrpcAudit: vi.fn(),
    annotateAudit: (
      ctx: Parameters<typeof actual.annotateAudit>[0],
      detail: Parameters<typeof actual.annotateAudit>[1]
    ) => {
      audit.annotateAudit(ctx, detail);
      actual.annotateAudit(ctx, detail);
    },
  };
});

import type { TRPCContext } from '../trpc';
import { pharmacyBranchAssignmentsRouter } from './pharmacy-branch-assignments';

type Actor = 'owner' | 'admin' | 'admin-with-deny';

function liveActor(kind: Actor) {
  if (kind === 'owner')
    return {
      status: 'ACTIVE',
      role: 'ADMIN',
      organizationRole: { key: 'owner', isSystem: true, permissions: [] },
      permissionOverrides: [],
    };
  return {
    status: 'ACTIVE',
    role: 'ADMIN',
    organizationRole: {
      key: 'manager',
      isSystem: false,
      permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
    },
    permissionOverrides:
      kind === 'admin-with-deny' ? [{ capability: 'pharmacy:counter', effect: 'DENY' }] : [],
  };
}

function fixture(kind: Actor, stored: boolean | null = false) {
  const db = {
    $transaction: async (work: (tx: unknown) => unknown) => work(db),
    $queryRaw: vi.fn(),
    pharmacyBranch: { updateMany: vi.fn(async () => ({ count: 1 })) },
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: { permissions: [] },
        permissionOverrides: [],
      })),
      findFirst: vi.fn(async () => ({
        ...liveActor(kind),
        id: 'admin-1',
        organizationId: 'org-a',
        organizationRole: { ...liveActor(kind).organizationRole, organizationId: 'org-a' },
      })),
    },
    organization: {
      findUnique: vi.fn(async () =>
        stored === null ? null : { pharmacyOtherBranchAvailability: stored }
      ),
      update: vi.fn(async ({ data }: { data: { pharmacyOtherBranchAvailability: boolean } }) => ({
        pharmacyOtherBranchAvailability: data.pharmacyOtherBranchAvailability,
      })),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'admin-1',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    db,
    caller: pharmacyBranchAssignmentsRouter.createCaller(context as unknown as TRPCContext),
  };
}

beforeEach(() => {
  audit.annotateAudit.mockClear();
});

describe('DEV-907 owner switch for other-branch availability', () => {
  it('is off by default and reads the stored organization', async () => {
    const f = fixture('owner', null);
    await expect(f.caller.otherBranchAvailability()).resolves.toEqual({
      enabled: false,
      canChange: true,
    });
    expect(f.db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-a' },
      select: { pharmacyOtherBranchAvailability: true },
    });
  });

  it('reports a stored switch and whether this member may change it', async () => {
    await expect(fixture('admin', true).caller.otherBranchAvailability()).resolves.toEqual({
      enabled: true,
      canChange: false,
    });
  });

  it('lets the owner turn it on and off, with an audit record', async () => {
    const f = fixture('owner');
    await expect(f.caller.setOtherBranchAvailability({ enabled: true })).resolves.toEqual({
      enabled: true,
    });
    expect(f.db.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-a' },
      data: { pharmacyOtherBranchAvailability: true },
      select: { pharmacyOtherBranchAvailability: true },
    });
    expect(audit.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'UPDATE',
        targetType: 'Organization',
        targetId: 'org-a',
        metadata: { pharmacyOtherBranchAvailability: true },
      })
    );
    await expect(f.caller.setOtherBranchAvailability({ enabled: false })).resolves.toEqual({
      enabled: false,
    });
  });

  it.each<Actor>(['admin', 'admin-with-deny'])(
    'refuses a %s who is not the owner and changes nothing',
    async (kind) => {
      const f = fixture(kind);
      await expect(f.caller.setOtherBranchAvailability({ enabled: true })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only the owner can change this setting.',
      });
      expect(f.db.organization.update).not.toHaveBeenCalled();
    }
  );
});

describe('controlled medicine branch witness requirement', () => {
  it('requires the live system owner to change a branch', async () => {
    const f = fixture('admin');
    await expect(
      f.caller.setControlledWitness({ branchId: 'branch-a', required: true })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyBranch.updateMany).not.toHaveBeenCalled();
  });

  it('saves the owner’s choice only for an active branch in this workspace and audits it', async () => {
    const f = fixture('owner');
    for (const required of [true, false]) {
      await expect(
        f.caller.setControlledWitness({ branchId: 'branch-a', required })
      ).resolves.toEqual({ required });
      expect(f.db.pharmacyBranch.updateMany).toHaveBeenLastCalledWith({
        where: { organizationId: 'org-a', id: 'branch-a', active: true },
        data: { requireSecondPharmacist: required },
      });
      expect(audit.annotateAudit).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          targetType: 'PharmacyBranch',
          targetId: 'branch-a',
          operation: 'UPDATE',
          metadata: { branchId: 'branch-a', requireSecondPharmacist: required },
        })
      );
    }
  });
});
