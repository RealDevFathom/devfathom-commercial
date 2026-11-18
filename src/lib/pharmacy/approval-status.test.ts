import { describe, expect, it } from 'vitest';

import {
  PHARMACY_APPROVED_MESSAGE,
  PHARMACY_AWAITING_APPROVAL_MESSAGE,
  RECENT_APPROVAL_MS,
  pharmacyApprovalMessage,
  pharmacyApprovalStatus,
  showsPharmacyApprovalNotice,
} from './approval-status';

// DEV-905: a pharmacy in onboarding is either waiting for DevFathom approval or has
// steps open; an active one is approved. Nothing here approves anything.
describe('pharmacyApprovalStatus', () => {
  it('waits for approval once every onboarding step is done', () => {
    const status = pharmacyApprovalStatus({
      status: 'ONBOARDING',
      readiness: { ready: true, openSteps: [] },
    });
    expect(status).toEqual({ state: 'AWAITING_APPROVAL' });
    expect(pharmacyApprovalMessage(status)).toBe(PHARMACY_AWAITING_APPROVAL_MESSAGE);
  });

  it('names the open onboarding steps while onboarding is not finished', () => {
    const status = pharmacyApprovalStatus({
      status: 'ONBOARDING',
      readiness: { ready: false, openSteps: ['Legal business', 'Opening stock readiness'] },
    });
    expect(status).toEqual({
      state: 'ONBOARDING_OPEN',
      openSteps: ['Legal business', 'Opening stock readiness'],
    });
    expect(pharmacyApprovalMessage(status)).toBe(
      'This pharmacy is still onboarding, so it cannot sell yet. These onboarding steps are still open: Legal business and Opening stock readiness.'
    );
  });

  it('never reads an onboarding pharmacy without a readiness answer as ready', () => {
    expect(pharmacyApprovalStatus({ status: 'ONBOARDING' })).toEqual({
      state: 'ONBOARDING_OPEN',
      openSteps: [],
    });
  });

  it('reads an active pharmacy as approved', () => {
    const status = pharmacyApprovalStatus({
      status: 'ACTIVE',
      activatedAt: new Date('2026-11-18T10:00:00Z'),
      readiness: { ready: false, openSteps: ['Ignored'] },
    });
    expect(status).toEqual({ state: 'APPROVED', approvedAt: '2026-11-18T10:00:00.000Z' });
    expect(pharmacyApprovalMessage(status)).toBe(PHARMACY_APPROVED_MESSAGE);
  });

  it.each(['SUSPENDED', 'GRACE', 'TERMINATED', 'PROSPECT'])(
    'says nothing about approval for a %s organization',
    (status) => {
      const answer = pharmacyApprovalStatus({ status });
      expect(answer).toEqual({ state: 'NOT_ACTIVE' });
      expect(pharmacyApprovalMessage(answer)).toBeNull();
    }
  );
});

describe('showsPharmacyApprovalNotice', () => {
  const now = new Date('2026-11-18T12:00:00Z');

  it('shows a waiting or onboarding pharmacy its notice', () => {
    expect(showsPharmacyApprovalNotice({ state: 'AWAITING_APPROVAL' }, now)).toBe(true);
    expect(showsPharmacyApprovalNotice({ state: 'ONBOARDING_OPEN', openSteps: ['A'] }, now)).toBe(
      true
    );
  });

  it('shows the approval for a week, then stops', () => {
    const recent = new Date(now.getTime() - 60_000).toISOString();
    const old = new Date(now.getTime() - RECENT_APPROVAL_MS - 1).toISOString();
    expect(showsPharmacyApprovalNotice({ state: 'APPROVED', approvedAt: recent }, now)).toBe(true);
    expect(showsPharmacyApprovalNotice({ state: 'APPROVED', approvedAt: old }, now)).toBe(false);
    expect(showsPharmacyApprovalNotice({ state: 'APPROVED', approvedAt: null }, now)).toBe(false);
  });

  it('shows nothing without an answer or for another lifecycle state', () => {
    expect(showsPharmacyApprovalNotice(null, now)).toBe(false);
    expect(showsPharmacyApprovalNotice({ state: 'NOT_ACTIVE' }, now)).toBe(false);
  });
});
