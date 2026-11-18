import { describe, expect, it } from 'vitest';

import {
  COUNTER_UNKNOWN_ERROR_MESSAGE,
  counterErrorMessage,
  counterErrorTone,
  counterSaleErrorMessage,
} from './counter-messages';
import {
  ASK_OWNER_OR_MANAGER,
  COUNTER_SETUP_GUIDANCE,
  counterSetupAdvice,
  counterSetupReason,
  type CounterSetupReason,
  AWAITING_APPROVAL_NEXT_STEP,
} from './counter-setup';
import { PHARMACY_AWAITING_APPROVAL_MESSAGE } from './approval-status';
import { BranchOperationDeniedError, type BranchOperationDenialReason } from './regulatory';

/**
 * DEV-860: the owner of a freshly seeded pharmacy saw "That action could not be
 * completed at the counter. Refresh and try again, or ask a supervisor." when the
 * server refused the first bill for a setup gap. Every refusal of sale creation and
 * add-to-cart now names what is missing.
 */
const REGULATORY_REASONS = [
  'ORGANIZATION_NOT_ACTIVE',
  'PROFILE_MISSING',
  'BRANCH_INACTIVE',
  'PROFILE_PREMISES_MISMATCH',
  'RULE_SET_UNCONFIRMED',
  'LICENCE_INVALID',
  'QUALIFIED_PERSON_COVERAGE_MISSING',
  'SCHEDULE_NOT_PERMITTED',
  'PHARMACIST_NOT_PRESENT',
] as const satisfies readonly BranchOperationDenialReason[];

const ALL_REASONS = Object.keys(COUNTER_SETUP_GUIDANCE) as CounterSetupReason[];

describe('counter setup reasons (DEV-860)', () => {
  it.each(REGULATORY_REASONS)(
    'says what is missing for the regulatory refusal %s, never the generic sentence',
    (reason) => {
      // Typed against the gate, so a new denial reason must be given words here.
      const error = new BranchOperationDeniedError(reason);
      const message = counterErrorMessage(new Error(error.reason));
      expect(message).not.toBe(COUNTER_UNKNOWN_ERROR_MESSAGE);
      expect(message).toBe(COUNTER_SETUP_GUIDANCE[reason].message);
      expect(message).not.toContain(reason);
      expect(counterSetupReason(new Error(reason))).toBe(reason);
    }
  );

  it('says the operator is not assigned, from the reason the refusal declares', () => {
    const error = Object.assign(new Error('Branch is outside your scope.'), {
      data: { code: 'FORBIDDEN', reason: 'BRANCH_NOT_ASSIGNED' },
    });
    expect(counterSetupReason(error)).toBe('BRANCH_NOT_ASSIGNED');
    expect(counterErrorMessage(error)).toBe(
      'You are not assigned to this branch, so you cannot sell here.'
    );
    expect(counterErrorTone(error)).toBe('warning');
  });

  it.each([
    'INTERNAL_FAILURE',
    'toString',
    '__proto__',
    'Tenant org-private at /server/internal.ts:42',
  ])('uses generic sale admission copy for an unknown error: %s', (message) => {
    expect(counterSaleErrorMessage(new Error(message))).toBe(COUNTER_UNKNOWN_ERROR_MESSAGE);
  });

  it.each(REGULATORY_REASONS)('keeps the safe sale admission message for %s', (reason) => {
    expect(counterSaleErrorMessage(new Error(reason))).toBe(COUNTER_SETUP_GUIDANCE[reason].message);
  });

  it('keeps the scope sentence when the refusal declares no reason', () => {
    const error = Object.assign(new Error('Branch is outside your scope.'), {
      data: { code: 'FORBIDDEN', reason: 'SOMETHING_ELSE' },
    });
    expect(counterSetupReason(error)).toBeNull();
    expect(counterErrorMessage(error)).toBe('Branch is outside your scope.');
  });

  it('keeps the drawer sentence it already had', () => {
    expect(counterErrorMessage(new Error('DRAWER_NOT_OPEN'))).toBe(
      'The cash drawer for this counter is not open. Open it before taking or paying out cash.'
    );
  });

  it('names what is missing for the reasons the owner hit on a fresh pharmacy', () => {
    expect(COUNTER_SETUP_GUIDANCE.PROFILE_MISSING.message).toMatch(/regulatory profile/);
    expect(COUNTER_SETUP_GUIDANCE.LICENCE_INVALID.message).toMatch(/licence/);
    expect(COUNTER_SETUP_GUIDANCE.LICENCE_INVALID.message).toMatch(/evidence/);
    expect(COUNTER_SETUP_GUIDANCE.QUALIFIED_PERSON_COVERAGE_MISSING.message).toMatch(/pharmacist/);
    expect(COUNTER_SETUP_GUIDANCE.NO_INDEPENDENT_PHARMACIST.message).toMatch(/staff PIN/);
    expect(COUNTER_SETUP_GUIDANCE.PHARMACIST_NOT_PRESENT.message).toMatch(/presence hours/);
    expect(COUNTER_SETUP_GUIDANCE.BRANCH_NOT_ASSIGNED.message).toMatch(/not assigned/);
    expect(COUNTER_SETUP_GUIDANCE.DRAWER_NOT_OPEN.message).toMatch(/drawer/);
  });

  it('does not treat prose or an unrelated code as a setup reason', () => {
    expect(counterSetupReason(new Error('Branch is outside your scope.'))).toBeNull();
    expect(counterSetupReason(new Error('INSUFFICIENT_STOCK'))).toBeNull();
    expect(counterSetupReason(new Error('toString'))).toBeNull();
    expect(counterSetupReason('PROFILE_MISSING')).toBeNull();
  });

  it.each(ALL_REASONS.filter((reason) => reason !== 'DRAWER_NOT_OPEN'))(
    'tells an operator who cannot fix %s to ask their owner or manager, with no setup link',
    (reason) => {
      const advice = counterSetupAdvice(reason, { canFixSetup: false, branchId: 'branch-1' });
      expect(advice).toEqual({
        reason,
        message: COUNTER_SETUP_GUIDANCE[reason].message,
        nextStep: ASK_OWNER_OR_MANAGER,
        link: null,
      });
    }
  );

  it.each(ALL_REASONS.filter((reason) => reason !== 'DRAWER_NOT_OPEN'))(
    'gives an owner or administrator the next step for %s',
    (reason) => {
      const advice = counterSetupAdvice(reason, { canFixSetup: true, branchId: 'branch 1' });
      expect(advice.nextStep).not.toBe(ASK_OWNER_OR_MANAGER);
      expect(Boolean(advice.link) || Boolean(advice.nextStep)).toBe(true);
    }
  );

  it.each([
    'PROFILE_MISSING',
    'PROFILE_PREMISES_MISMATCH',
    'LICENCE_INVALID',
    'QUALIFIED_PERSON_COVERAGE_MISSING',
    'SCHEDULE_NOT_PERMITTED',
    'PHARMACIST_NOT_PRESENT',
  ] as const)('links an owner to this branch’s regulatory profile for %s', (reason) => {
    const advice = counterSetupAdvice(reason, { canFixSetup: true, branchId: 'branch 1' });
    expect(advice.link?.href).toBe('/pharmacy/regulatory?branch=branch%201');
    expect(advice.link?.label).toMatch(/^[A-Z][a-z]/);
  });

  it('links an owner to branch assignments for a missing assignment', () => {
    expect(
      counterSetupAdvice('BRANCH_NOT_ASSIGNED', { canFixSetup: true, branchId: 'b' }).link
    ).toEqual({ href: '/pharmacy/settings/branches', label: 'Open branch assignments' });
  });

  it('sends nobody else to open the drawer: the operator opens it on the counter', () => {
    for (const canFixSetup of [true, false]) {
      expect(counterSetupAdvice('DRAWER_NOT_OPEN', { canFixSetup, branchId: 'b' })).toMatchObject({
        nextStep: null,
        link: null,
      });
    }
  });
});

// DEV-905: a workspace that is not active because it is still onboarding says so plainly,
// instead of "contact support to reactivate".
describe('counter advice for a pharmacy awaiting approval (DEV-905)', () => {
  it('tells everyone a complete pharmacy is waiting for DevFathom approval', () => {
    for (const canFixSetup of [true, false]) {
      expect(
        counterSetupAdvice('ORGANIZATION_NOT_ACTIVE', {
          canFixSetup,
          branchId: 'branch-1',
          approval: { state: 'AWAITING_APPROVAL' },
        })
      ).toEqual({
        reason: 'ORGANIZATION_NOT_ACTIVE',
        message: PHARMACY_AWAITING_APPROVAL_MESSAGE,
        nextStep: AWAITING_APPROVAL_NEXT_STEP,
        link: null,
      });
    }
  });

  it('names the open onboarding steps, with the onboarding page for the owner', () => {
    const approval = { state: 'ONBOARDING_OPEN' as const, openSteps: ['Legal business'] };
    expect(
      counterSetupAdvice('ORGANIZATION_NOT_ACTIVE', {
        canFixSetup: true,
        branchId: 'branch-1',
        approval,
      })
    ).toEqual({
      reason: 'ORGANIZATION_NOT_ACTIVE',
      message:
        'This pharmacy is still onboarding, so it cannot sell yet. This onboarding step is still open: Legal business.',
      nextStep: null,
      link: { href: '/pharmacy', label: 'Finish the onboarding steps' },
    });
    expect(
      counterSetupAdvice('ORGANIZATION_NOT_ACTIVE', {
        canFixSetup: false,
        branchId: 'branch-1',
        approval,
      })
    ).toMatchObject({ nextStep: ASK_OWNER_OR_MANAGER, link: null });
  });

  it('keeps the reactivation advice for a workspace that is not onboarding', () => {
    expect(
      counterSetupAdvice('ORGANIZATION_NOT_ACTIVE', {
        canFixSetup: true,
        branchId: 'branch-1',
        approval: { state: 'NOT_ACTIVE' },
      })
    ).toEqual(counterSetupAdvice('ORGANIZATION_NOT_ACTIVE', { canFixSetup: true, branchId: 'b' }));
    expect(
      counterSetupAdvice('ORGANIZATION_NOT_ACTIVE', { canFixSetup: true, branchId: 'branch-1' })
        .message
    ).toBe('This workspace is not active, so the counter cannot sell.');
  });

  it('only changes the advice for an inactive workspace', () => {
    expect(
      counterSetupAdvice('PROFILE_MISSING', {
        canFixSetup: true,
        branchId: 'branch-1',
        approval: { state: 'AWAITING_APPROVAL' },
      }).message
    ).toBe(COUNTER_SETUP_GUIDANCE.PROFILE_MISSING.message);
  });
});
