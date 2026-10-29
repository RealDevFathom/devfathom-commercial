import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { recordAudit } from '@/server/audit';
import {
  assertBranchMayOperate,
  assertStoredBranchMayOperate,
  BranchOperationDeniedError,
  pendingLegalReviewAllowed,
  type BranchRegulatoryState,
  type BranchOperationDenialReason,
} from './regulatory';

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const at = new Date('2026-10-24T12:00:00.000Z');
const action = { name: 'DISPENSE', at, schedule: 'H' };
const fields = ['licenceCategories', 'permittedSchedules', 'pharmacistCoverageRule'] as const;

function sindh(): BranchRegulatoryState {
  return {
    branchId: 'synthetic-sindh',
    licenceCategory: 'RETAIL',
    licenceValidFrom: new Date('2026-01-01'),
    licenceValidTo: new Date('2027-01-01'),
    licenceEvidenceFileRef: 'synthetic/licence',
    permittedSchedules: ['G', 'H'],
    qualifiedPersonRegistration: 'synthetic-qp',
    qualifiedPersonValidFrom: new Date('2026-01-01'),
    qualifiedPersonValidTo: new Date('2027-01-01'),
    qualifiedPersonCoverageRosterRef: 'synthetic/roster',
    ruleSet: {
      code: 'PK-SD',
      licenceCategories: {
        values: ['RETAIL', 'WHOLESALE'],
        provisional: false,
        pendingLegalReview: true,
      },
      permittedSchedules: { values: ['G', 'H'], provisional: false, pendingLegalReview: true },
      pharmacistCoverageRule: {
        values: { minimumHoursPerWeek: 40 },
        provisional: false,
        pendingLegalReview: true,
      },
    },
    auditDenied: vi.fn(),
  };
}

function denyOnce(
  state: BranchRegulatoryState,
  reason: BranchOperationDenialReason = 'RULE_SET_PENDING_LEGAL_REVIEW'
) {
  expect(() => assertBranchMayOperate(state, action)).toThrow(
    new BranchOperationDeniedError(reason)
  );
  expect(state.auditDenied).toHaveBeenCalledExactlyOnceWith(reason, action);
}

function confirm(state: BranchRegulatoryState) {
  for (const field of fields) {
    state.ruleSet[field] = { ...(state.ruleSet[field] as object), pendingLegalReview: false };
  }
  return state;
}

describe('#129 pending-legal-review enforcement', () => {
  it('evaluates an explicit environment without consulting process globals', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('APP_ENV', 'staging');
    expect(pendingLegalReviewAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(pendingLegalReviewAllowed({ NODE_ENV: 'production', APP_ENV: 'pilot' })).toBe(true);
  });

  it.each([undefined, '', 'production', 'development', 'test', 'preview', 'STAGING', 'unknown'])(
    'fails closed for production APP_ENV=%s and audits the denial once',
    (appEnv: string | undefined) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('APP_ENV', appEnv);
      expect(pendingLegalReviewAllowed()).toBe(false);
      denyOnce(sindh());
    }
  );

  it.each([
    ['test', undefined],
    ['development', undefined],
    ['production', 'staging'],
    ['production', 'pilot'],
  ])(
    'retains the existing %s/%s non-production contract',
    (nodeEnv: string, appEnv: string | undefined) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('APP_ENV', appEnv);
      expect(pendingLegalReviewAllowed()).toBe(true);
      const state = sindh();
      expect(() => assertBranchMayOperate(state, action)).not.toThrow();
      expect(state.auditDenied).not.toHaveBeenCalled();
    }
  );

  it.each(fields)(
    'denies a pending flag on %s even if the other fields are confirmed',
    (field: (typeof fields)[number]) => {
      vi.stubEnv('NODE_ENV', 'production');
      const state = confirm(sindh());
      state.ruleSet[field] = { ...(state.ruleSet[field] as object), pendingLegalReview: true };
      denyOnce(state);
    }
  );

  it.each(fields)(
    'does not grandfather an absent or malformed Sindh %s review flag',
    (field: (typeof fields)[number]) => {
      vi.stubEnv('NODE_ENV', 'production');
      for (const flag of [undefined, null, 'false', 0]) {
        const state = confirm(sindh());
        state.ruleSet[field] = { ...(state.ruleSet[field] as object), pendingLegalReview: flag };
        denyOnce(state);
      }
    }
  );

  it('denies pending rules outside Sindh too, without imposing a review flag on other confirmed rules', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const pending = sindh();
    pending.ruleSet.code = 'PK-TEST';
    denyOnce(pending);
    const confirmed = confirm(sindh());
    confirmed.ruleSet.code = 'PK-TEST';
    for (const field of fields) {
      const rule = { ...(confirmed.ruleSet[field] as Record<string, unknown>) };
      delete rule.pendingLegalReview;
      confirmed.ruleSet[field] = rule;
    }
    expect(() => assertBranchMayOperate(confirmed, action)).not.toThrow();
  });

  it('accepts only explicit confirmation for all relevant Sindh fields in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertBranchMayOperate(confirm(sindh()), action)).not.toThrow();
  });

  it.each(['production', 'staging', 'pilot'])(
    'never allows provisional rules in %s',
    (appEnv: string | undefined) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('APP_ENV', appEnv);
      const state = sindh();
      state.ruleSet.licenceCategories = { values: [], provisional: true };
      denyOnce(state, 'RULE_SET_UNCONFIRMED');
    }
  );

  it('does not bypass evidence, licence, qualified-person or schedule checks in a pilot', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', 'pilot');
    const evidence = sindh();
    evidence.licenceEvidenceFileRef = '';
    denyOnce(evidence, 'LICENCE_INVALID');
    const expired = sindh();
    expired.licenceValidTo = at;
    denyOnce(expired, 'LICENCE_INVALID');
    const qp = sindh();
    qp.qualifiedPersonCoverageRosterRef = '';
    denyOnce(qp, 'QUALIFIED_PERSON_COVERAGE_MISSING');
    const schedule = sindh();
    schedule.permittedSchedules = ['G'];
    denyOnce(schedule, 'SCHEDULE_NOT_PERMITTED');
  });
});

describe('#129 stored profile version resolution', () => {
  function database(profile: unknown, latestRules: unknown) {
    const findProfile = vi.fn().mockResolvedValue(profile);
    const findRules = vi.fn().mockResolvedValue(latestRules);
    return {
      db: {
        branchRegulatoryProfile: { findFirst: findProfile },
        jurisdictionRuleSet: { findFirst: findRules },
      } as unknown as PrismaClient,
      findProfile,
      findRules,
    };
  }

  function profile(state = sindh()) {
    const { ruleSet, auditDenied, ...value } = state;
    void auditDenied;
    return { ...value, jurisdictionRuleSet: ruleSet };
  }

  it('uses the latest in-force version rather than a grandfathered profile reference', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { db, findRules } = database(profile(confirm(sindh())), sindh().ruleSet);
    await expect(
      assertStoredBranchMayOperate(db, 'org-synthetic', 'synthetic-sindh', action)
    ).rejects.toMatchObject({ reason: 'RULE_SET_PENDING_LEGAL_REVIEW' });
    expect(findRules).toHaveBeenCalledExactlyOnceWith({
      where: {
        code: 'PK-SD',
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    });
    expect(recordAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        organizationId: 'org-synthetic',
        errorCode: 'RULE_SET_PENDING_LEGAL_REVIEW',
        outcome: 'FAILURE',
      })
    );
  });

  it('still blocks a legacy unflagged Sindh profile if no current rule is returned', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const legacy = sindh();
    for (const field of fields) {
      const rule = { ...(legacy.ruleSet[field] as Record<string, unknown>) };
      delete rule.pendingLegalReview;
      legacy.ruleSet[field] = rule;
    }
    const { db } = database(profile(legacy), null);
    await expect(
      assertStoredBranchMayOperate(db, 'org-synthetic', 'synthetic-sindh', action)
    ).rejects.toMatchObject({ reason: 'RULE_SET_PENDING_LEGAL_REVIEW' });
    expect(recordAudit).toHaveBeenCalledOnce();
  });

  it('does not query rules or lose the existing audited missing-profile denial', async () => {
    const { db, findRules } = database(null, null);
    await expect(
      assertStoredBranchMayOperate(db, 'org-synthetic', 'missing', action)
    ).rejects.toMatchObject({ reason: 'PROFILE_MISSING' });
    expect(findRules).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledOnce();
  });
});
