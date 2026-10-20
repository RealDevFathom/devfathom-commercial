/**
 * Account self-service does not need the `hr` module.
 *
 * Regression: in a hotel or pharmacy package (no `hr`), Settings → Profile read the
 * caller through `team.getById` and saved through `team.updateProfile`; both answered
 * FORBIDDEN "The HR module is not enabled for this organization", so Edit did nothing.
 * Reading your own profile is account self-service; reading another member is still
 * the licensed team directory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements');
  return { ...actual, resolveOrganizationEntitlements: vi.fn() };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/email', () => ({ appUrl: vi.fn(), sendEmail: vi.fn(), templates: {} }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn() }));

import { ACCOUNT_PROCEDURES, moduleForProcedure } from '@/lib/module-catalog';
import { router, type TRPCContext } from '../trpc';
import { teamRouter } from './team';

const app = router({ team: teamRouter });
const HR_REFUSAL = 'The HR module is not enabled for this organization.';

function caller(enabledModules: string[], role = 'EMPLOYEE') {
  return app.createCaller({
    db: { user: { findUnique: mocks.findUnique, update: mocks.update } },
    entitlements: {
      organizationId: 'org_1',
      enabledModules,
      modules: [{ key: 'hr', name: 'HR', enabled: enabledModules.includes('hr') }],
      activeSeats: 1,
      seatLimit: 50,
    },
    session: {
      expires: 'later',
      user: { id: 'user_self', role, status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1', isDemo: false },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).team;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({ id: 'user_self', name: 'Hotel General Manager' });
  mocks.update.mockResolvedValue({ id: 'user_self', name: 'Hotel GM' });
});

describe('module catalog', () => {
  it('leaves every account self-service procedure unlicensed and the directory on hr', () => {
    for (const path of ACCOUNT_PROCEDURES) expect(moduleForProcedure(path)).toBeNull();
    expect(ACCOUNT_PROCEDURES.has('team.getById')).toBe(true);
    expect(ACCOUNT_PROCEDURES.has('team.updateProfile')).toBe(true);
    expect(moduleForProcedure('team.getAll')).toBe('hr');
    expect(moduleForProcedure('team.updateRole')).toBe('hr');
    expect(moduleForProcedure('team.getNotifications')).toBe('hr');
  });
});

describe('team.getById', () => {
  it('reads the caller without the hr module', async () => {
    await expect(caller([]).getById({ id: 'user_self' })).resolves.toMatchObject({
      id: 'user_self',
    });
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user_self' } })
    );
  });

  it('still refuses another member without the hr module, with the catalog wording', async () => {
    await expect(caller([]).getById({ id: 'user_other' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: HR_REFUSAL,
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('reads another member once hr is licensed', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'user_other', name: 'Front desk' });
    await expect(caller(['hr']).getById({ id: 'user_other' })).resolves.toMatchObject({
      id: 'user_other',
    });
  });
});

describe('team.updateProfile', () => {
  it('saves the caller profile without the hr module', async () => {
    await expect(caller([]).updateProfile({ name: 'Hotel GM', skills: [] })).resolves.toMatchObject(
      { id: 'user_self' }
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'user_self' },
      data: { name: 'Hotel GM', skills: [] },
    });
  });
});

describe('team directory procedures', () => {
  it('keep the hr licence', async () => {
    await expect(caller([]).getAll()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: HR_REFUSAL,
    });
  });
});
