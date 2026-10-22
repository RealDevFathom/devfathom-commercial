// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Loyalty 5 hold fix: explicit-DENY coverage for the staff refill-reminder
 * preference mutation, through the real central `can()` (not mocked here).
 */
const mocks = vi.hoisted(() => ({
  rules: vi.fn(),
  patient: vi.fn(),
  setPreference: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/lib/storage', () => ({ putUpload: vi.fn(), getUpload: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/refill-reminder-sender', () => ({
  setRefillReminderPreference: mocks.setPreference,
}));

import type { TRPCContext } from '../trpc';
import { pharmacyPrescriptionsRouter } from './pharmacy-prescriptions';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });

function grant(role: Rule[], overrides: Rule[] = []) {
  mocks.rules.mockResolvedValue({
    organizationRole: { permissions: role },
    permissionOverrides: overrides,
  });
}

function optOut() {
  return pharmacyPrescriptionsRouter
    .createCaller({
      db: {
        user: { findUnique: mocks.rules },
        pharmacyPatient: { findFirst: mocks.patient },
      },
      entitlements: {
        organizationId: 'org-a',
        modules: [],
        enabledModules: ['pharmacy-dispensing'],
      },
      session: {
        expires: 'later',
        user: { id: 'user-a', organizationId: 'org-a', role: 'EMPLOYEE', status: 'ACTIVE' },
      },
      organization: { id: 'org-a' },
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext)
    .setRefillReminderOptOut({ patientId: 'patient-a', optedOut: true });
}

const REFUSAL = { code: 'FORBIDDEN', message: 'You do not have permission for this action.' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.patient.mockResolvedValue({ id: 'patient-a' });
  mocks.setPreference.mockResolvedValue(true);
});

describe('setRefillReminderOptOut authorization', () => {
  it('refuses a member without pharmacy:counter before any read or write', async () => {
    grant([allow('pharmacy:orders'), allow('pharmacy:inventory')]);
    await expect(optOut()).rejects.toMatchObject(REFUSAL);
    expect(mocks.patient).not.toHaveBeenCalled();
    expect(mocks.setPreference).not.toHaveBeenCalled();
  });

  it('records the staff choice for the exact grant, as the session actor', async () => {
    grant([allow('pharmacy:counter')]);
    await expect(optOut()).resolves.toEqual({ patientId: 'patient-a', optedOut: true });
    expect(mocks.setPreference).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org-a',
      patientId: 'patient-a',
      optedOut: true,
      source: 'STAFF',
      actorUserId: 'user-a',
    });
  });

  it('lets a user DENY override beat a role ALLOW', async () => {
    grant([allow('pharmacy:counter')], [deny('pharmacy:counter')]);
    await expect(optOut()).rejects.toMatchObject(REFUSAL);
    expect(mocks.setPreference).not.toHaveBeenCalled();
  });

  it('lets a wildcard DENY override beat the exact role grant', async () => {
    grant([allow('pharmacy:counter')], [deny('pharmacy:*')]);
    await expect(optOut()).rejects.toMatchObject(REFUSAL);
    expect(mocks.setPreference).not.toHaveBeenCalled();
  });

  // Needs fix/abac-deny-precedence (6b120a50): can() on this base reads user
  // overrides before role rules, so a user ALLOW still beats a role DENY. This
  // case passes on a local merge with 6b120a50; make it a plain `it` once merged.
  it.fails('lets a role DENY beat a user ALLOW override', async () => {
    grant([deny('pharmacy:counter')], [allow('pharmacy:counter')]);
    await expect(optOut()).rejects.toMatchObject(REFUSAL);
    expect(mocks.setPreference).not.toHaveBeenCalled();
  });
});
