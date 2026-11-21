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
  // DEV-961: one sole owner's approval authenticator and recovery codes.
  approvalAuthenticators: [] as any[],
  recoveryCodes: [] as any[],
}));
vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: async () => 'hashed' }));
vi.mock('@/lib/secret-crypto', () => ({ decryptSecret: () => 'totp-secret' }));
vi.mock('@/lib/totp', () => ({ verifyTotp: (_secret: string, code: string) => code === '123456' }));
const db = {
  organizationIdentityConnection: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
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
  user: {
    update: vi.fn(async () => ({
      id: 'user_1',
      organizationId: 'org_1',
      email: 'owner@tenant.test',
      role: 'ADMIN',
    })),
    findMany: vi.fn(async () => [{ id: 'user_1' }, { id: 'admin_2' }]),
    findUnique: vi.fn(async ({ where }: any) =>
      where.id === 'user_1'
        ? { id: 'user_1', organizationId: 'org_1', email: 'owner@tenant.test', role: 'ADMIN' }
        : null
    ),
  },
  approvalAuthenticator: {
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = state.approvalAuthenticators.length;
      state.approvalAuthenticators = state.approvalAuthenticators.filter(
        (row) => !(row.organizationId === where.organizationId && row.userId === where.userId)
      );
      return { count: before - state.approvalAuthenticators.length };
    }),
    findFirst: vi.fn(
      async ({ where }: any) =>
        state.approvalAuthenticators.find(
          (row) => row.organizationId === where.organizationId && row.userId === where.userId
        ) ?? null
    ),
  },
  approvalAuthenticatorRecoveryCode: {
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = state.recoveryCodes.length;
      state.recoveryCodes = state.recoveryCodes.filter(
        (row) => !(row.organizationId === where.organizationId && row.userId === where.userId)
      );
      return { count: before - state.recoveryCodes.length };
    }),
  },
  notification: { createMany: vi.fn(async ({ data }: any) => ({ count: data.length })) },
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
import { approvalAuthenticatorGate } from '@/lib/approval-authenticator-gate';
const req = new Request('http://admin.localhost/api/platform/control');
const execute = (action: string, payload: unknown, role = 'SUPER_ADMIN', id = 'actor_1') =>
  executePlatformCommand({ id, role } as any, action, payload, req);
const actions = [
  'organization.user.password',
  // DEV-961: resetting a member's approval authenticator.
  'organization.user.approvalauthenticator.reset',
  'organization.scim.token',
  'organization.scim.revoke',
  'organization.identity',
  'organization.identity.test',
  'organization.identity.remove',
  'organization.transition',
  // DEV-905: approving a pharmacy past its checks, and withdrawing that approval.
  'organization.pharmacy.approve',
  'organization.pharmacy.approval.withdraw',
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
  state.approvalAuthenticators = [];
  state.recoveryCodes = [];
});

describe('OIDC connection saves', () => {
  const payload = {
    organizationId: 'org_1',
    name: 'Synthetic identity',
    protocol: 'OIDC',
    reason: 'Validate identity settings',
    authenticationCode: '123456',
  };

  it('saves a syntactically valid public destination without fetching a document', async () => {
    db.organizationIdentityConnection.create.mockResolvedValueOnce({
      id: 'fixture',
      organizationId: 'org_1',
    });
    await execute('organization.identity', { ...payload, issuer: 'https://8.8.8.8/tenant' });
    expect(db.organizationIdentityConnection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ issuer: 'https://8.8.8.8/tenant' }),
    });
  });

  it('refuses a forbidden discovery address before creating a connection', async () => {
    await expect(
      execute('organization.identity', { ...payload, discoveryUrl: 'https://192.0.2.1/document' })
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('public HTTPS') });
    expect(db.organizationIdentityConnection.create).not.toHaveBeenCalled();
  });

  it('validates the effective stored issuer on a partial update', async () => {
    db.organizationIdentityConnection.findUnique.mockResolvedValue({
      issuer: 'http://idp.example',
      discoveryUrl: null,
    });
    await expect(
      execute('organization.identity', { ...payload, id: 'connection' })
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('public HTTPS') });
    expect(db.organizationIdentityConnection.update).not.toHaveBeenCalled();
  });
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

  // DEV-905: the lock stops the pharmacy, so it also withdraws a super admin's approval,
  // which would otherwise let the pharmacy keep running without a regulatory profile.
  it('withdraws a platform approval when it locks the placeholder', async () => {
    state.organization = {
      id: 'org_1',
      vertical: 'PHARMACY',
      status: 'ACTIVE',
      platformApprovedAt: new Date('2026-11-18T09:00:00.000Z'),
      platformApprovedById: 'actor_1',
    };
    state.placeholderActive = true;

    await execute('organization.pharmacy.placeholder.lock', {
      organizationId: 'org_1',
      reason,
      authenticationCode: '123456',
    });

    expect(db.organization.update).toHaveBeenCalledWith({
      where: { id: 'org_1' },
      data: expect.objectContaining({
        status: 'ONBOARDING',
        activatedAt: null,
        platformApprovedAt: null,
        platformApprovedById: null,
        platformApprovalNote: null,
      }),
    });
    expect(state.organization.platformApprovedAt).toBeNull();
    expect(state.audits.at(-1)).toMatchObject({
      after: expect.objectContaining({ platformApprovalWithdrawn: true }),
    });
  });

  it('withdraws an approval on an onboarding pharmacy with nothing else to lock', async () => {
    state.organization = {
      id: 'org_1',
      vertical: 'PHARMACY',
      status: 'ONBOARDING',
      platformApprovedAt: new Date('2026-11-18T09:00:00.000Z'),
    };

    await execute('organization.pharmacy.placeholder.lock', {
      organizationId: 'org_1',
      reason,
      authenticationCode: '123456',
    });

    expect(db.organization.update).toHaveBeenCalledWith({
      where: { id: 'org_1' },
      data: expect.objectContaining({ platformApprovedAt: null }),
    });
    expect(db.organization.update.mock.calls[0]![0].data).not.toHaveProperty('status');
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

  it('upgrades a grandfathered placeholder to a dated, branch-bound successor', async () => {
    state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ACTIVE' };
    const legacy = {
      id: 'legacy_placeholder',
      version: 3,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
      isPlaceholder: true,
      jurisdictionRuleSetId: 'pk_pb_placeholder_v1',
      premises: { label: 'PLACEHOLDER – not a real licence' },
    };
    state.latestProfile = legacy;
    db.pharmacyBranch.findMany.mockResolvedValueOnce([
      {
        id: 'branch_1',
        provinceCode: 'PB',
        active: true,
        addressLine: '12 Mall Road',
        city: 'Lahore',
      } as any,
    ]);
    db.branchRegulatoryProfile.findFirst.mockImplementation(async ({ where }: any) =>
      where?.isPlaceholder ? legacy : state.latestProfile
    );

    try {
      await execute('organization.pharmacy.placeholder.apply', {
        organizationId: 'org_1',
        reason,
        authenticationCode: '123456',
      });
    } finally {
      db.branchRegulatoryProfile.findFirst.mockReset();
      db.branchRegulatoryProfile.findFirst.mockImplementation(async ({ where }: any) => {
        if (where?.isPlaceholder) {
          return state.placeholderActive ? { id: 'placeholder_profile', effectiveTo: null } : null;
        }
        return state.latestProfile;
      });
    }

    // Append-only: the legacy row is closed, never rewritten or deleted.
    expect(db.branchRegulatoryProfile.deleteMany).not.toHaveBeenCalled();
    expect(db.branchRegulatoryProfile.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'legacy_placeholder' },
      data: { effectiveTo: expect.any(Date) },
    });
    const successor = db.branchRegulatoryProfile.create.mock.calls[0]![0].data;
    expect(successor).toMatchObject({
      version: 4,
      isPlaceholder: true,
      jurisdictionRuleSetId: 'pk_pb_placeholder_v1',
      provinceCode: 'PB',
      premises: { addressLine: '12 Mall Road', city: 'Lahore' },
    });
    expect(successor.effectiveFrom.getTime()).toBe(
      db.branchRegulatoryProfile.update.mock.calls[0]![0].data.effectiveTo.getTime()
    );
    // The organization is not knocked out of ACTIVE by the upgrade.
    expect(db.organization.update).not.toHaveBeenCalled();
    expect(state.lifecycleEvents).toEqual([
      expect.objectContaining({
        actorId: 'actor_1',
        metadata: expect.objectContaining({
          operation: 'PREMISES_BINDING_UPGRADE',
          supersededProfileIds: ['legacy_placeholder'],
        }),
      }),
    ]);
    expect(state.audits.at(-1)).toMatchObject({
      after: {
        placeholder: true,
        premisesBindingUpgrade: { supersededProfileIds: ['legacy_placeholder'] },
      },
    });
  });

  it('leaves a current, branch-bound placeholder alone when re-applied', async () => {
    state.organization = { id: 'org_1', vertical: 'PHARMACY', status: 'ONBOARDING' };
    state.placeholderActive = true;

    await execute('organization.pharmacy.placeholder.apply', {
      organizationId: 'org_1',
      reason,
      authenticationCode: '123456',
    });

    expect(db.branchRegulatoryProfile.create).not.toHaveBeenCalled();
    expect(db.branchRegulatoryProfile.update).not.toHaveBeenCalled();
    expect(state.lifecycleEvents).toEqual([]);
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
      expect(db.notification.createMany).not.toHaveBeenCalled();
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
  it('forces a password change at next sign-in and revokes sessions after a platform reset', async () => {
    await execute('organization.user.password', {
      id: 'user_1',
      password: 'a-secret-password',
      reason: 'Verified owner recovery',
    });
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user_1' },
        data: expect.objectContaining({
          password: 'hashed',
          passwordChangedAt: null,
          mustChangePassword: true,
          tokenVersion: { increment: 1 },
        }),
      })
    );
    expect(state.audits[0]).toMatchObject({
      action: 'organization.user.password',
      actorPlatformUserId: 'actor_1',
      targetId: 'user_1',
      organizationId: 'org_1',
      success: true,
      after: {
        email: 'owner@tenant.test',
        role: 'ADMIN',
        mustChangePassword: true,
        sessionsRevoked: true,
        notifiedUserIds: ['user_1', 'admin_2'],
        reason: 'Verified owner recovery',
      },
    });
  });
  it('notifies the target user and tenant administrators of a platform password reset', async () => {
    await executePlatformCommand(
      { id: 'actor_1', role: 'SUPER_ADMIN', name: 'Platform Operator' } as any,
      'organization.user.password',
      { id: 'user_1', password: 'a-secret-password', reason: 'Verified owner recovery' },
      req
    );
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org_1', role: 'ADMIN' }),
      })
    );
    const rows = db.notification.createMany.mock.calls[0][0].data;
    expect(rows.map((row: any) => row.userId)).toEqual(['user_1', 'admin_2']);
    for (const row of rows) {
      expect(row).toMatchObject({
        organizationId: 'org_1',
        type: 'platform_password_reset',
        entityType: 'User',
        entityId: 'user_1',
      });
      expect(row.message).toContain('Platform Operator');
      expect(row.message).toContain('owner@tenant.test');
      expect(row.message).toContain('Verified owner recovery');
      expect(row.message).not.toContain('a-secret-password');
    }
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

describe('DEV-961 platform reset of an approval authenticator', () => {
  const reason = 'Sole owner lost phone and recovery codes; identity verified by call-back';

  it('lets a sole owner who lost his phone and his recovery codes set up again, audited', async () => {
    state.approvalAuthenticators = [
      { id: 'auth_owner', organizationId: 'org_1', userId: 'user_1', enabledAt: new Date() },
    ];
    state.recoveryCodes = [
      { organizationId: 'org_1', userId: 'user_1', codeHash: 'a'.repeat(64), usedAt: null },
    ];
    const gate = () =>
      approvalAuthenticatorGate(
        {
          organization: { findFirst: async () => ({ requireApprovalAuthenticator: true }) },
          approvalAuthenticator: db.approvalAuthenticator,
        } as never,
        { organizationId: 'org_1', userId: 'user_1', approver: true }
      );
    // Enrolled: his account works, but the phone is gone and nobody else in the
    // organization can reset it.
    await expect(gate()).resolves.toMatchObject({ setupRequired: false });

    await executePlatformCommand(
      { id: 'actor_1', role: 'SUPER_ADMIN', name: 'Platform Operator' } as any,
      'organization.user.approvalauthenticator.reset',
      { id: 'user_1', reason },
      req
    );
    expect(state.approvalAuthenticators).toEqual([]);
    expect(state.recoveryCodes).toEqual([]);
    // The next request takes him to the set-up screen, where he enrols a new phone.
    await expect(gate()).resolves.toMatchObject({ setupRequired: true });
    expect(state.audits.at(-1)).toMatchObject({
      action: 'organization.user.approvalauthenticator.reset',
      actorPlatformUserId: 'actor_1',
      targetId: 'user_1',
      organizationId: 'org_1',
      success: true,
      after: {
        approvalAuthenticatorReset: true,
        recoveryCodesRemoved: 1,
        notifiedUserIds: ['user_1', 'admin_2'],
        reason,
      },
    });
    const rows = db.notification.createMany.mock.calls.at(-1)![0].data;
    expect(rows.map((row: any) => row.userId)).toEqual(['user_1', 'admin_2']);
    for (const row of rows) {
      expect(row.type).toBe('platform_approval_authenticator_reset');
      expect(row.message).toContain('Platform Operator');
      expect(row.message).toContain(reason);
    }
  });

  it('needs the security permission and a reason, and never touches a secret', async () => {
    state.approvalAuthenticators = [
      { id: 'auth_owner', organizationId: 'org_1', userId: 'user_1', enabledAt: new Date() },
    ];
    for (const role of ['OPERATIONS', 'SUPPORT', 'SALES', 'FINANCE', 'AUDITOR'])
      await expect(
        execute('organization.user.approvalauthenticator.reset', { id: 'user_1', reason }, role)
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      execute('organization.user.approvalauthenticator.reset', {
        id: 'user_1',
        reason,
        encryptedSecret: 'v1.attacker.chosen',
      })
    ).rejects.toThrow();
    expect(state.approvalAuthenticators).toHaveLength(1);
    expect(db.approvalAuthenticator.deleteMany).not.toHaveBeenCalled();
  });
});
