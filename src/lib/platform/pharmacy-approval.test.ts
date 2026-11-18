import { describe, expect, it } from 'vitest';

import {
  confirmsUnmetChecks,
  PHARMACY_APPROVAL_NOTE_MAX_LENGTH,
  PHARMACY_APPROVAL_REASON,
  pharmacyApprovalCommand,
  pharmacyApprovalReason,
  pharmacyApprovalWithdrawCommand,
} from './pharmacy-approval';

// DEV-905 (owner decision, 18 Nov): approval is its own manual platform command; the
// operator confirms the unmet checks by name, and withdrawal is a command of its own.
describe('pharmacy approval commands', () => {
  it('sends the approval with the note and the confirmed unmet checks', () => {
    expect(
      pharmacyApprovalCommand('org_1', ' Checked licence ', ['PREMISES_AND_LICENCES'])
    ).toEqual({
      action: 'organization.pharmacy.approve',
      payload: {
        id: 'org_1',
        reason: `${PHARMACY_APPROVAL_REASON} Note: Checked licence`,
        note: 'Checked licence',
        confirmedUnmetChecks: ['PREMISES_AND_LICENCES'],
      },
    });
    expect(pharmacyApprovalCommand('org_1')).toEqual({
      action: 'organization.pharmacy.approve',
      payload: { id: 'org_1', reason: PHARMACY_APPROVAL_REASON, confirmedUnmetChecks: [] },
    });
  });

  it('sends the withdrawal with the trimmed reason', () => {
    expect(pharmacyApprovalWithdrawCommand('org_1', '  Licence never issued  ')).toEqual({
      action: 'organization.pharmacy.approval.withdraw',
      payload: { id: 'org_1', reason: 'Licence never issued' },
    });
  });

  it('meets the sensitive reason contract with or without a note', () => {
    for (const note of [undefined, null, '', '   ', 'ok', 'x'.repeat(2000)]) {
      const reason = pharmacyApprovalReason(note);
      expect(reason.length).toBeGreaterThanOrEqual(10);
      expect(reason.length).toBeLessThanOrEqual(500);
    }
    expect(pharmacyApprovalReason('   ')).toBe(PHARMACY_APPROVAL_REASON);
  });

  it('keeps the whole note up to its limit', () => {
    const note = 'n'.repeat(PHARMACY_APPROVAL_NOTE_MAX_LENGTH);
    expect(pharmacyApprovalReason(note)).toBe(`${PHARMACY_APPROVAL_REASON} Note: ${note}`);
  });

  it('accepts only a confirmation of exactly the unmet checks', () => {
    expect(confirmsUnmetChecks([], [])).toBe(true);
    expect(confirmsUnmetChecks(['A', 'B'], ['B', 'A'])).toBe(true);
    expect(confirmsUnmetChecks(['A', 'B'], ['A'])).toBe(false);
    expect(confirmsUnmetChecks(['A'], ['A', 'B'])).toBe(false);
    expect(confirmsUnmetChecks(['A'], [])).toBe(false);
    expect(confirmsUnmetChecks([], ['A'])).toBe(false);
  });
});
