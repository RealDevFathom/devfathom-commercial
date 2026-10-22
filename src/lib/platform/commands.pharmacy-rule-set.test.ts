import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
  ruleCreate: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'rules_pk_pb_v2',
    ...data,
  })),
  ruleFindFirst: vi.fn(async () => ({
    version: 1,
    effectiveFrom: new Date('2026-09-02T00:00:00.000Z'),
  })),
  query: vi.fn(async () => []),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));

const platformDb = {
  $queryRawUnsafe: mocks.query,
  jurisdictionRuleSet: {
    findFirst: mocks.ruleFindFirst,
    create: mocks.ruleCreate,
  },
  platformAuditLog: { create: mocks.auditCreate },
};

vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: typeof platformDb) => Promise<unknown>) =>
    run(platformDb)
  ),
}));

import { executePlatformCommand } from './commands';
import { PHARMACY_RULE_SET_COMMANDS } from './pharmacy-rule-set-commands';

const request = new Request('https://admin.devfathom.test/api/platform/control', {
  method: 'POST',
  headers: { 'x-devfathom-request-id': 'confirm_rules_1' },
});
const actor = (role: 'SUPER_ADMIN' | 'OPERATIONS', mfaEnabled = true) =>
  ({ id: 'operator_1', role, mfaEnabled }) as never;
const payload = {
  code: 'PK-PB',
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  reason: 'Counsel confirmed the published values.',
  licenceCategories: ['A', 'B'],
  permittedSchedules: ['B', 'C'],
  prescriptionOnlyClasses: ['controlled'],
  prescriptionRetentionDays: { controlled: 730 },
  controlledRegisterFlags: { required: true },
  pharmacistCoverageRule: { required: true },
  recordRetentionByClass: { prescription: 730 },
};

describe('pharmacy.ruleset.confirm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a non-SuperAdmin through the central capability check', async () => {
    await expect(
      executePlatformCommand(
        actor('OPERATIONS'),
        PHARMACY_RULE_SET_COMMANDS.confirm,
        payload,
        request
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.ruleCreate).not.toHaveBeenCalled();
  });

  it('requires an MFA-authenticated step-up session', async () => {
    await expect(
      executePlatformCommand(
        actor('SUPER_ADMIN', false),
        PHARMACY_RULE_SET_COMMANDS.confirm,
        payload,
        request
      )
    ).rejects.toMatchObject({ status: 403, message: 'MFA step-up is required for this action.' });
    expect(mocks.ruleCreate).not.toHaveBeenCalled();
  });

  it('appends a confirmed version and writes its platform audit record', async () => {
    await executePlatformCommand(
      actor('SUPER_ADMIN'),
      PHARMACY_RULE_SET_COMMANDS.confirm,
      payload,
      request
    );

    expect(mocks.ruleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        code: 'PK-PB',
        version: 2,
        effectiveFrom: new Date('2026-11-01T00:00:00.000Z'),
        licenceCategories: { values: ['A', 'B'], provisional: false },
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorPlatformUserId: 'operator_1',
        action: PHARMACY_RULE_SET_COMMANDS.confirm,
        targetType: 'JurisdictionRuleSet',
        targetId: 'rules_pk_pb_v2',
      }),
    });
  });
});
