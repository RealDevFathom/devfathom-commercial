import { describe, expect, it } from 'vitest';

import {
  PHARMACY_APPROVAL_NOTE_MAX_LENGTH,
  PHARMACY_APPROVAL_REASON,
  pharmacyApprovalCommand,
  pharmacyApprovalReason,
} from './pharmacy-approval';

// DEV-905: approval is the existing lifecycle transition to ACTIVE, never a new path.
describe('pharmacy approval command', () => {
  it('sends the existing lifecycle transition to ACTIVE', () => {
    expect(pharmacyApprovalCommand('org_1', 'Checked licence')).toEqual({
      action: 'organization.transition',
      payload: {
        id: 'org_1',
        status: 'ACTIVE',
        reason: `${PHARMACY_APPROVAL_REASON} Note: Checked licence`,
      },
    });
  });

  it('meets the transition reason contract with or without a note', () => {
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
});
