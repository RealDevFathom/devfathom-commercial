/* eslint-disable @typescript-eslint/no-explicit-any -- Partial Prisma delegates model only the operations exercised by these boundary tests. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  audits: [] as any[],
  operator: {} as any,
  remaining: 0,
  organization: { id: 'org_1', vertical: 'AGENCY', status: 'ONBOARDING' } as any,
  placeholderActive: false,
  latestProfile: null as any,
  lifecycleEvents: [] as any[],
}));
vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: async () => 'hashed' }));
vi.mock('@/lib/secret-crypto', () => ({ decryptSecret: () => 'totp-secret' }));
vi.mock('@/lib/totp', () => ({ verifyTotp: (_secret: string, code: string) => code === '123456' }));
const db = {
  $queryRawUnsafe: vi.fn(async (sql: string) =>
    sql.startsWith('SELECT id FROM organizations') ? [{ id: state.organization.id }] : []
  ),
  platformUser: {
    findUnique: vi.fn(async () => state.operator),
    count: vi.fn(async () => state.remaining),
    update: vi.fn(async ({ data }: any) => ({ id: 'target_1', ...data })),
    create: vi.fn(async ({ data }: any) => ({ id: 'new_1', ...data })),
  },
  platformSession: { updateMany: vi.fn() },
  user: { update: vi.fn(async () => ({ id: 'user_1', organizationId: 'org_1' })) },
  organization: {
    findUnique: vi.fn(async () => state.organization),
    update: vi.fn(async ({ data }: any) => {
      state.organization = { ...state.organization, ...data };
      return state.organization;
    }),
  },
  jurisdictionRuleSet: {
    upsert: vi.fn(async ({ create }: any) => create),
  },
  pharmacyBranch: {
    findMany: vi.fn(async () => [{ id: 'branch_1', provinceCode: 'PB', active: true }]),
  },
  branchRegulatoryProfile: {
    findFirst: vi.fn(async ({ where }: any) => {
      if (where?.isPlaceholder) {
        return state.placeholderActive ? { id: 'placeholder_profile', effectiveTo: null } : null;
      }
      return state.latestProfile;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      if (where?.id === 'placeholder_profile' && data.effectiveTo) state.placeholderActive = false;
      state.latestProfile = { ...state.latestProfile, ...data };
      return state.latestProfile;
    }),
    create: vi.fn(async ({ data }: any) => {
      state.placeholderActive = true;
      return { id: 'placeholder_profile', ...data };
    }),
    findMany: vi.fn(async () =>
      state.placeholderActive
        ? [{ id: 'placeholder_profile', effectiveFrom: new Date('2026-01-01T00:00:00.000Z') }]
        : []
    ),
    deleteMany: vi.fn(async () => {
      const count = state.placeholderActive ? 1 : 0;
      state.placeholderActive = false;
      return { count };
    }),
  },
  platformAuditLog: {
    create: vi.fn(async ({ data }: any) => {
      state.audits.push(data);
      return data;
    }),
  },
  organizationLifecycleEvent: {
    create: vi.fn(async ({ data }: any) => {
      state.lifecycleEvents.push(data);
      return data;
    }),
  },
};
vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: (fn: any) => fn(db) }));
import { executePlatformCommand } from '@/lib/platform/commands';
const req = new Request('http://admin.localhost/api/platform/control');
const execute = (action: string, payload: unknown, role = 'SUPER_ADMIN', id = 'actor_1') =>
  executePlatformCommand({ id, role } as any, action, payload, req);
const actions = [
  'organization.user.password',
  'organization.scim.token',
  'organization.scim.revoke',
  'organization.identity',
  'organization.identity.test',
  'organization.identity.remove',
  'organization.transition',
];
beforeEach(() => {
  vi.clearAllMocks();
  state.audits = [];
  state.operator = {
    id: 'target_1',
    role: 'SUPER_ADMIN',
    active: true,
    encryptedTotpSecret: 'encrypted',
    mfaEnabledAt: new Date(),
  };
  state.remaining = 0;
  state.organization = { id: 'org_1', vertical: 'AGENCY', status: 'ONBOARDING' };
  state.placeholderActive = false;
  state.latestProfile = null;
  state.lifecycleEvents = [];
});

describe('pharmacy placeholder commands', () => {
  const reason = 'Owner-approved temporary activation';

  it.each(['OPERATIONS', 'SUPPORT', 'SALES', 'FINANCE', 'AUDITOR'])(
    'does not allow a %s platform user to apply or lock the placeholder',
    async (role) => {
      for (const action of [
        'organization.pharmacy.placeholder.apply',
        'organization.pharmacy.placeholder.lock',
      ]) {
        await expect(
          execute(action, { organizationId: 'org_1', reason, authenticationCode: '123456' }, role)
        ).rejects.toMatchObject({ status: 403 });
      }
      expect(db.jurisdictionRuleSet.upsert).not.toHaveBeenCalled();
      expect(db.branchRegulatoryProfile.deleteMany).not.toHaveBeenCalled();
    }
  );

  it('refuses a tenant administrator identity before any placeholder write', async () => {
    await expect(
      executePlatformCommand(
        { id: 'actor_1', role: 'ADMIN', capabilities: [] } as any,
        'organization.pharmacy.placeholder.apply',
        { organizationId: 'org_1', reason, authenticationCode: '123456' },
        req
      )
    ).rejects.toThrow(); // tenant roles are not platform roles; capability lookup refuses them
    expect(db.jurisdictionRuleSet.upsert).not.toHaveBeenCalled();
  });

  it('creates only flagged, non-provisional wildcard rules and labelled branch fields', async () => {
    state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ONBOARDING' };

    await execute('organization.pharmacy.placeholder.apply', {
      organizationId: 'org_1',
      reason,
      authenticationCode: '123456',
    });

    const rule = db.jurisdictionRuleSet.upsert.mock.calls[0]![0].create;
    expect(rule).toMatchObject({
      id: 'pk_pb_placeholder_v1',
      isPlaceholder: true,
      licenceCategories: { values: ['*'], provisional: false },
      permittedSchedules: { values: ['*'], provisional: false },
      controlledRegisterFlags: { values: { recordEverySale: true }, provisional: false },
      pharmacistCoverageRule: { values: { dispenseGrantRequired: true }, provisional: false },
    });
    for (const field of [
      rule.licenceCategories,
      rule.permittedSchedules,
      rule.prescriptionOnlyClasses,
      rule.prescriptionRetentionDays,
      rule.controlledRegisterFlags,
      rule.pharmacistCoverageRule,
      rule.recordRetentionByClass,
    ]) {
      expect(field.label).toBe('PLACEHOLDER – not a real licence');
      expect(field.provisional).toBe(false);
    }

    const profile = db.branchRegulatoryProfile.create.mock.calls[0]![0].data;
    expect(profile).toMatchObject({
      isPlaceholder: true,
      licenceNumber: 'PLACEHOLDER – not a real licence',
      licenceIssuingAuthority: 'PLACEHOLDER – not a real licence',
      licenceExpiryLabel: 'PLACEHOLDER – not a real licence',
      qualifiedPersonRegistration: 'PLACEHOLDER – not a real licence',
      permittedSchedules: ['OTC', 'RX', 'CONTROLLED'],
    });
    expect(state.audits.at(-1)).toMatchObject({ metadata: { placeholder: true } });
    expect(state.lifecycleEvents.at(-1)).toMatchObject({
      actorId: 'actor_1',
      metadata: { placeholder: true, operation: 'APPLIED' },
    });
  });

  it('applies a province-matched placeholder rule set to a Sindh branch (#977)', async () => {
    state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ONBOARDING' };
    db.pharmacyBranch.findMany.mockResolvedValueOnce([
      { id: 'branch_sd', provinceCode: 'PK-SD', active: true },
      { id: 'branch_pb', provinceCode: 'PK-PB', active: true },
    ]);
    // Neither branch has a placeholder or an earlier profile: two lookups each.
    for (let call = 0; call < 4; call += 1) {
      db.branchRegulatoryProfile.findFirst.mockResolvedValueOnce(null);
    }

    await execute('organization.pharmacy.placeholder.apply', {
      organizationId: 'org_1',
      reason,
      authenticationCode: '123456',
    });

    const rules = db.jurisdictionRuleSet.upsert.mock.calls.map((call: any) => call[0].create);
    expect(rules).toEqual([
      expect.objectContaining({
        id: 'pk_sd_placeholder_v1',
        code: 'PK-SD-PLACEHOLDER',
        isPlaceholder: true,
      }),
      expect.objectContaining({
        id: 'pk_pb_placeholder_v1',
        code: 'PK-PB-PLACEHOLDER',
        isPlaceholder: true,
      }),
    ]);
    const profiles = db.branchRegulatoryProfile.create.mock.calls.map((call: any) => call[0].data);
    expect(profiles).toEqual([
      expect.objectContaining({
        branchId: 'branch_sd',
        provinceCode: 'PK-SD',
        jurisdictionRuleSetId: 'pk_sd_placeholder_v1',
      }),
      expect.objectContaining({
        branchId: 'branch_pb',
        provinceCode: 'PK-PB',
        jurisdictionRuleSetId: 'pk_pb_placeholder_v1',
      }),
    ]);
  });

  it('locks append-only, closes placeholder profiles, and returns an active org to onboarding', async () => {
    state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ACTIVE' };
    state.placeholderActive = true;

    const payload = { organizationId: 'org_1', reason, authenticationCode: '123456' };
    await execute('organization.pharmacy.placeholder.lock', payload);
    await execute('organization.pharmacy.placeholder.lock', payload);

    expect(db.branchRegulatoryProfile.deleteMany).not.toHaveBeenCalled();
    expect(db.branchRegulatoryProfile.update).toHaveBeenCalledWith({
      where: { id: 'placeholder_profile' },
      data: { effectiveTo: expect.any(Date) },
    });
    expect(db.organization.update).toHaveBeenCalledWith({
      where: { id: 'org_1' },
      data: { status: 'ONBOARDING', activatedAt: null },
    });
    expect(db.organizationLifecycleEvent.create).toHaveBeenCalledOnce();
    expect(db.organizationLifecycleEvent.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_1',
        action: 'CREATED',
        fromStatus: 'ACTIVE',
        toStatus: 'ONBOARDING',
        reason,
        actorId: 'actor_1',
        metadata: { placeholder: true, operation: 'LOCKED', closed: 1 },
      },
    });
    expect(state.audits.at(-1)).toMatchObject({ metadata: { placeholder: true } });
    expect(state.lifecycleEvents.at(-1)).toMatchObject({
      actorId: 'actor_1',
      metadata: { placeholder: true, operation: 'LOCKED' },
    });
  });

  it.each(['organization.pharmacy.placeholder.apply', 'organization.pharmacy.placeholder.lock'])(
    '%s requires a fresh per-command MFA code',
    async (action) => {
      state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ONBOARDING' };
      for (const authenticationCode of ['', '000000']) {
        await expect(
          execute(action, { organizationId: 'org_1', reason, authenticationCode })
        ).rejects.toMatchObject({ status: 403 });
      }
      expect(db.branchRegulatoryProfile.create).not.toHaveBeenCalled();
      expect(db.branchRegulatoryProfile.deleteMany).not.toHaveBeenCalled();
    }
  );

  it('supersedes an open real licence profile before applying the placeholder', async () => {
    state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ONBOARDING' };
    state.latestProfile = {
      id: 'real_profile',
      version: 7,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
      isPlaceholder: false,
    };

    await execute('organization.pharmacy.placeholder.apply', {
      organizationId: 'org_1',
      reason,
      authenticationCode: '123456',
    });

    expect(db.branchRegulatoryProfile.update).toHaveBeenCalledWith({
      where: { id: 'real_profile' },
      data: { effectiveTo: expect.any(Date) },
    });
    expect(db.branchRegulatoryProfile.create.mock.calls[0]![0].data.version).toBe(8);
  });

  it.each(['AGENCY', 'RESTAURANT'])(
    'rejects a %s organization without changing it',
    async (vertical) => {
      state.organization = { id: 'org_1', vertical, status: 'ACTIVE' };
      state.placeholderActive = true;

      await expect(
        execute('organization.pharmacy.placeholder.lock', {
          organizationId: 'org_1',
          reason,
          authenticationCode: '123456',
        })
      ).rejects.toThrow('A Pharmacy organization is required.');

      expect(state.organization.status).toBe('ACTIVE');
      expect(db.branchRegulatoryProfile.deleteMany).not.toHaveBeenCalled();
      expect(db.organization.update).not.toHaveBeenCalled();
      expect(db.organizationLifecycleEvent.create).not.toHaveBeenCalled();
    }
  );

  it('locks a non-ACTIVE pharmacy without changing its status and still records a lifecycle event', async () => {
    state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ONBOARDING' };
    state.placeholderActive = true;

    await execute('organization.pharmacy.placeholder.lock', {
      organizationId: 'org_1',
      reason,
      authenticationCode: '123456',
    });

    expect(db.branchRegulatoryProfile.deleteMany).not.toHaveBeenCalled();
    expect(db.organization.update).not.toHaveBeenCalled();
    expect(db.organizationLifecycleEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        fromStatus: 'ONBOARDING',
        toStatus: 'ONBOARDING',
        metadata: expect.objectContaining({ placeholder: true, operation: 'LOCKED' }),
      }),
    });
  });

  it.each(['organization.pharmacy.placeholder.apply', 'organization.pharmacy.placeholder.lock'])(
    '%s locks the organization row before reading state',
    async (action) => {
      state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ONBOARDING' };
      state.placeholderActive = true;
      await execute(action, { organizationId: 'org_1', reason, authenticationCode: '123456' });
      expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
        'org_1'
      );
    }
  );

  it('flags failed platform commands while the placeholder is active', async () => {
    state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ACTIVE' };
    state.placeholderActive = true;

    await expect(
      execute('organization.pharmacy.placeholder.apply', {
        organizationId: 'org_1',
        reason: 'short',
        authenticationCode: '123456',
      })
    ).rejects.toThrow();

    expect(state.audits.at(-1)).toMatchObject({
      success: false,
      metadata: { outcomeCategory: 'validation_failed', placeholder: true },
    });
  });
});
describe('sensitive commands', () => {
  it.each(['OPERATIONS', 'SUPPORT', 'SALES', 'FINANCE', 'AUDITOR'])(
    'denies and audits every sensitive command for %s',
    async (role) => {
      for (const action of actions) {
        await expect(
          execute(action, { id: 'target_1', reason: 'A valid business reason' }, role)
        ).rejects.toMatchObject({ status: 403 });
        expect(state.audits.at(-1)).toMatchObject({
          action,
          success: false,
          metadata: { outcomeCategory: 'capability_denied' },
        });
      }
      expect(db.user.update).not.toHaveBeenCalled();
    }
  );
  it.each(actions)('%s requires a nonblank reason before writes', async (action) => {
    for (const reason of [undefined, '', '   ', 'short']) {
      await expect(execute(action, { id: 'target_1', reason })).rejects.toThrow();
    }
    expect(db.user.update).not.toHaveBeenCalled();
    expect(state.audits).toHaveLength(4);
  });
  it('allows SA password reset and audits the reason without the password', async () => {
    await execute('organization.user.password', {
      id: 'user_1',
      password: 'a-secret-password',
      reason: 'Verified owner recovery',
    });
    expect(db.user.update).toHaveBeenCalledOnce();
    expect(state.audits[0].after).toMatchObject({
      reason: 'Verified owner recovery',
      passwordReset: true,
    });
    expect(JSON.stringify(state.audits)).not.toContain('a-secret-password');
  });
  it('denies an OPERATIONS vertical correction before mutation', async () => {
    await expect(
      execute(
        'organization.update',
        {
          id: 'org_1',
          vertical: 'RESTAURANT',
          packageId: 'pkg_1',
          reason: 'Correct initial vertical',
        },
        'OPERATIONS'
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(state.audits.at(-1).success).toBe(false);
  });
  it('requires a reason on SA vertical corrections', async () => {
    await expect(
      execute('organization.update', { id: 'org_1', vertical: 'RESTAURANT', packageId: 'pkg_1' })
    ).rejects.toThrow();
  });
});
describe('operator safety', () => {
  const payload = {
    id: 'target_1',
    name: 'Target',
    email: 'target@example.com',
    role: 'SUPPORT',
    mfaRequired: false,
  };
  it.each([{ role: 'SUPPORT' }, { role: 'SUPER_ADMIN', active: false }])(
    'rejects last-SA reduction %j',
    async (change) => {
      await expect(execute('operator.upsert', { ...payload, ...change })).rejects.toMatchObject({
        status: 403,
      });
      expect(db.platformUser.update).not.toHaveBeenCalled();
      expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(1597, 1)');
    }
  );
  it('allows another-SA demotion when one remains and revokes target sessions', async () => {
    state.remaining = 1;
    await execute('operator.upsert', payload);
    expect(db.platformUser.update).toHaveBeenCalledOnce();
    expect(db.platformSession.updateMany).toHaveBeenCalledOnce();
  });
  it.each([{ role: 'SUPPORT' }, { role: 'SUPER_ADMIN', active: false }])(
    'rejects self reduction even with another admin %j',
    async (change) => {
      state.remaining = 2;
      await expect(
        execute('operator.upsert', { ...payload, ...change }, 'SUPER_ADMIN', 'target_1')
      ).rejects.toMatchObject({ status: 403 });
      expect(db.platformUser.update).not.toHaveBeenCalled();
    }
  );
  it('allows creation with mandatory MFA before enrollment', async () => {
    await execute('operator.upsert', {
      name: 'New',
      email: 'new@example.com',
      role: 'SUPER_ADMIN',
      password: 'a-valid-password',
      mfaRequired: true,
    });
    expect(db.platformUser.create).toHaveBeenCalledOnce();
  });
});
