/**
 * DEV-298 — a regulatory profile saved effective "today" is in force from the
 * workspace's local midnight. A PKT workspace must not see it as scheduled
 * between 00:00 and 04:59 PKT because the stored date is UTC midnight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  organizationFindFirst: vi.fn(),
  branchFindMany: vi.fn(),
  profileFindMany: vi.fn(),
  ruleSetFindMany: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  recordAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacyOnboardingRouter } from './pharmacy-onboarding';

function context(): TRPCContext {
  return {
    db: {
      organization: { findFirst: mocks.organizationFindFirst },
      pharmacyBranch: { findMany: mocks.branchFindMany },
      branchRegulatoryProfile: { findMany: mocks.profileFindMany },
      jurisdictionRuleSet: { findMany: mocks.ruleSetFindMany },
    },
    entitlements: {
      organizationId: 'pharmacy-org',
      enabledModules: ['pharmacy-core'],
      modules: [{ key: 'pharmacy-core', name: 'Pharmacy', enabled: true }],
    },
    session: {
      expires: 'later',
      user: { id: 'admin', organizationId: 'pharmacy-org', role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: { id: 'pharmacy-org' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
}

const confirmed = {
  licenceCategories: { provisional: false, values: ['PHARMACY'] },
  permittedSchedules: { provisional: false, values: ['RX'] },
  pharmacistCoverageRule: { provisional: false, values: {} },
};

const today = new Date('2026-10-21T00:00:00.000Z');

function versionStartingToday() {
  return {
    id: 'profile-2',
    branchId: 'branch-1',
    version: 2,
    effectiveFrom: today,
    effectiveTo: null,
    provinceCode: 'PK-PB',
    licenceCategory: 'PHARMACY',
    licenceNumber: 'LIC-1',
    licenceValidFrom: today,
    licenceValidTo: new Date('2027-10-21T00:00:00.000Z'),
    licenceEvidenceFileRef: '/api/files/licence.pdf',
    permittedSchedules: ['RX'],
    qualifiedPersonRegistration: 'QP-1',
    qualifiedPersonValidFrom: today,
    qualifiedPersonValidTo: new Date('2027-10-21T00:00:00.000Z'),
    qualifiedPersonCoverageRosterRef: '/api/files/roster.pdf',
    ntn: null,
    strn: null,
    fiscalStatus: 'UNCONFIRMED',
    retentionPolicy: {},
    premises: { addressLine: '12 Mall Road', city: 'Lahore' },
    createdAt: new Date('2026-10-20T18:00:00.000Z'),
    isPlaceholder: false,
    jurisdictionRuleSetId: 'pk_pb_v1',
    jurisdictionRuleSet: confirmed,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.branchFindMany.mockResolvedValue([
    {
      id: 'branch-1',
      name: 'Mall Road',
      city: 'Lahore',
      addressLine: '12 Mall Road',
      provinceCode: 'PB',
    },
  ]);
  mocks.profileFindMany.mockResolvedValue([versionStartingToday()]);
  mocks.ruleSetFindMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('regulatory profile start day (DEV-298)', () => {
  it.each(['2026-10-20T19:00:00.000Z', '2026-10-20T23:59:59.999Z'])(
    'shows a PKT profile effective today as in force at %s',
    async (instant) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(instant));
      mocks.organizationFindFirst.mockResolvedValue({ timezone: 'Asia/Karachi' });

      const result = await pharmacyOnboardingRouter.createCaller(context()).regulatory();

      expect(result.versions[0]).toMatchObject({ effective: true, inForce: true });
    }
  );

  it('still shows it as scheduled the minute before PKT midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T18:59:59.999Z'));
    mocks.organizationFindFirst.mockResolvedValue({ timezone: 'Asia/Karachi' });

    const result = await pharmacyOnboardingRouter.createCaller(context()).regulatory();

    expect(result.versions[0]).toMatchObject({ effective: false, inForce: false });
  });
});
