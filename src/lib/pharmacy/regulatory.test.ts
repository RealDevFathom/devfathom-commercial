import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));

import {
  assertBranchMayOperate,
  assertStoredPharmacyMayOperate,
  BranchOperationDeniedError,
  evaluateBranchRegulatoryStatus,
  type BranchRegulatoryState,
} from './regulatory';

const at = new Date('2026-09-02T12:00:00.000Z');

function validState(): BranchRegulatoryState {
  return {
    branchId: 'branch-a',
    licenceCategory: 'PHARMACY',
    licenceValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    licenceValidTo: new Date('2027-01-01T00:00:00.000Z'),
    licenceEvidenceFileRef: '/api/files/licence-evidence.pdf',
    permittedSchedules: ['RX'],
    qualifiedPersonRegistration: 'QP-1',
    qualifiedPersonValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    qualifiedPersonValidTo: new Date('2027-01-01T00:00:00.000Z'),
    qualifiedPersonCoverageRosterRef: 'roster-1',
    ruleSet: {
      licenceCategories: { provisional: false, values: ['PHARMACY'] },
      permittedSchedules: { provisional: false, values: ['RX'] },
      pharmacistCoverageRule: { provisional: false, values: {} },
    },
    auditDenied: vi.fn(),
  };
}

function expectDenied(state: BranchRegulatoryState, reason: BranchOperationDeniedError['reason']) {
  expect(() =>
    assertBranchMayOperate(state, {
      name: 'DISPENSE',
      at,
      schedule: 'RX',
      requiresQualifiedPerson: true,
    })
  ).toThrowError(new BranchOperationDeniedError(reason));
  expect(state.auditDenied).toHaveBeenCalledOnce();
  expect(state.auditDenied).toHaveBeenCalledWith(
    reason,
    expect.objectContaining({ name: 'DISPENSE' })
  );
}

describe('assertBranchMayOperate', () => {
  it('permits a confirmed, valid licence, coverage and schedule', () => {
    const state = validState();
    expect(() =>
      assertBranchMayOperate(state, {
        name: 'DISPENSE',
        at,
        schedule: 'RX',
        requiresQualifiedPerson: true,
      })
    ).not.toThrow();
    expect(state.auditDenied).not.toHaveBeenCalled();
  });

  it('accepts real licence evidence through the same activation primitive', () => {
    const state = validState();
    state.licenceEvidenceFileRef = '/api/files/licence-evidence.pdf';

    expect(() =>
      assertBranchMayOperate(state, {
        name: 'ACTIVATE',
        at,
        requiresQualifiedPerson: true,
      })
    ).not.toThrow();
  });

  it('does not bypass the controlled schedule or qualified-person Rx gate', () => {
    const controlled = validState();
    controlled.permittedSchedules = [];
    expectDenied(controlled, 'SCHEDULE_NOT_PERMITTED');

    const rx = validState();
    rx.qualifiedPersonCoverageRosterRef = '';
    expectDenied(rx, 'QUALIFIED_PERSON_COVERAGE_MISSING');
  });

  it.each(['OTC', 'RX', 'CONTROLLED'])(
    'permits %s through the placeholder wildcards',
    (schedule) => {
      const state = validState();
      state.licenceCategory = '*';
      state.permittedSchedules = ['OTC', 'RX', 'CONTROLLED'];
      state.ruleSet.licenceCategories = { provisional: false, values: ['*'] };
      state.ruleSet.permittedSchedules = { provisional: false, values: ['*'] };

      expect(() =>
        assertBranchMayOperate(state, {
          name: 'DISPENSE',
          at,
          schedule,
          requiresQualifiedPerson: true,
        })
      ).not.toThrow();
    }
  );

  it('fails closed and audits an expired licence', () => {
    const state = validState();
    state.licenceValidTo = at;
    expectDenied(state, 'LICENCE_INVALID');
  });

  it('fails closed and audits missing qualified-person coverage', () => {
    const state = validState();
    state.qualifiedPersonCoverageRosterRef = '';
    expectDenied(state, 'QUALIFIED_PERSON_COVERAGE_MISSING');
  });

  it('fails closed and audits a schedule absent from the branch licence', () => {
    const state = validState();
    state.permittedSchedules = [];
    expectDenied(state, 'SCHEDULE_NOT_PERMITTED');
  });

  it('never treats a provisional jurisdiction rule as a warning', () => {
    const state = validState();
    state.ruleSet.licenceCategories = { provisional: true, values: ['PHARMACY'] };
    expectDenied(state, 'RULE_SET_UNCONFIRMED');
  });
});

describe('assertStoredPharmacyMayOperate', () => {
  const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

  function storedDb(status: string | null, profile: unknown = null) {
    const order: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        order.push(strings.join('?').includes('organizations') ? 'lock:org' : 'lock:profile');
        return [];
      }),
      organization: {
        findUnique: vi.fn(async () => {
          order.push('read:org');
          return status === null ? null : { status };
        }),
      },
      branchRegulatoryProfile: {
        findFirst: vi.fn(async () => {
          order.push('read:profile');
          return profile;
        }),
      },
    };
    return { db, order };
  }

  it('refuses an onboarding organization before inspecting its branch profile', async () => {
    const { db } = storedDb('ONBOARDING');

    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', {
        name: 'pharmacy.sale.create',
      })
    ).rejects.toEqual(new BranchOperationDeniedError('ORGANIZATION_NOT_ACTIVE'));
    expect(db.branchRegulatoryProfile.findFirst).not.toHaveBeenCalled();
  });

  it.each(['PROSPECT', 'SUSPENDED', 'TERMINATED', 'PURGING', 'PURGED', null])(
    'refuses a %s organization',
    async (status) => {
      const { db } = storedDb(status);

      await expect(
        assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', {
          name: 'pharmacy.sale.tender',
        })
      ).rejects.toEqual(new BranchOperationDeniedError('ORGANIZATION_NOT_ACTIVE'));
    }
  );

  it.each(['ACTIVE', 'GRACE'])(
    'lets a %s organization through to the branch profile check',
    async (status) => {
      const { db } = storedDb(status);

      // No profile: the denial now comes from the branch, proving the lifecycle check passed.
      await expect(
        assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', {
          name: 'pharmacy.sale.tender',
        })
      ).rejects.toEqual(new BranchOperationDeniedError('PROFILE_MISSING'));
      expect(db.branchRegulatoryProfile.findFirst).toHaveBeenCalled();
    }
  );

  it('admits a GRACE organization whose branch has a valid profile', async () => {
    const { auditDenied: _auditDenied, ruleSet, ...profile } = validState();
    const { db } = storedDb('GRACE', { ...profile, jurisdictionRuleSet: ruleSet });

    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', {
        name: 'pharmacy.sale.create',
        at,
      })
    ).resolves.toBeUndefined();
  });

  it('share-locks the organization and open branch profiles before reading them', async () => {
    const { db, order } = storedDb('ACTIVE');

    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', {
        name: 'pharmacy.sale.create',
      })
    ).rejects.toEqual(new BranchOperationDeniedError('PROFILE_MISSING'));
    expect(order).toEqual(['lock:org', 'lock:profile', 'read:org', 'read:profile']);
    const [orgLock, profileLock] = db.$queryRaw.mock.calls.map(sqlOf);
    expect(orgLock).toMatch(/FROM organizations WHERE id = \? FOR SHARE/);
    expect(profileLock).toMatch(/pharmacy_branch_regulatory_profiles[\s\S]*FOR SHARE/);
    expect(db.$queryRaw.mock.calls[0]!.slice(1)).toEqual(['org-a']);
    expect(db.$queryRaw.mock.calls[1]!.slice(1)).toEqual(['org-a', 'branch-a']);
  });

  it('refuses an active organization when the branch has no effective profile', async () => {
    const { db } = storedDb('ACTIVE');

    await expect(
      assertStoredPharmacyMayOperate(db as never, 'org-a', 'branch-a', {
        name: 'pharmacy.sale.tender',
      })
    ).rejects.toEqual(new BranchOperationDeniedError('PROFILE_MISSING'));
  });
});

describe('evaluateBranchRegulatoryStatus', () => {
  it('stops reporting in force at the exact licence-expiry instant', () => {
    const state = validState();
    state.licenceValidTo = new Date('2026-10-21T00:00:00.000Z');
    const { auditDenied: _auditDenied, ...profile } = state;

    expect(
      evaluateBranchRegulatoryStatus(profile, true, new Date('2026-10-20T23:59:59.999Z'))
    ).toMatchObject({ effective: true, inForce: true, licenceExpired: false });
    expect(
      evaluateBranchRegulatoryStatus(profile, true, new Date('2026-10-21T00:00:00.000Z'))
    ).toMatchObject({ effective: true, inForce: false, licenceExpired: true });
  });

  it('does not call a historical, ineffective version in force', () => {
    const { auditDenied: _auditDenied, ...profile } = validState();

    expect(evaluateBranchRegulatoryStatus(profile, false, at)).toMatchObject({
      effective: false,
      inForce: false,
      licenceExpired: false,
      qualifiedPersonCoverageExpired: false,
    });
  });
});
