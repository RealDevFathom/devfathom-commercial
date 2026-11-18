import { describe, expect, it } from 'vitest';

import {
  auditActionLabel,
  auditApproverIds,
  auditCategoryLabel,
  auditOperationLabel,
  auditRoleLabel,
  auditRowBranchId,
} from './audit-labels';

describe('DEV-913 plain-language audit labels', () => {
  it('names pharmacy actions and categories without internal codes', () => {
    expect(auditActionLabel('pharmacySales.returnAndRefund')).toBe(
      'Counter and sales: Return and refund'
    );
    expect(auditActionLabel('pharmacyInventory.recordWriteOff')).toBe('Stock: Record write off');
    expect(auditActionLabel('pharmacyOffline.replayOfflineSale')).toBe(
      'Offline counter: Replay offline sale'
    );
    expect(auditActionLabel('auth.loginFailed')).toBe('Failed sign-in');
    expect(auditActionLabel('POST /api/v1/tasks')).toBe('POST /api/v1/tasks');
    expect(auditCategoryLabel('PHARMACYSALES')).toBe('Counter and sales');
    expect(auditCategoryLabel('PHARMACY')).toBe('Pharmacy');
    expect(auditCategoryLabel('AUTH')).toBe('Sign-in');
    expect(auditCategoryLabel('SOME_NEW_AREA')).toBe('Some new area');
    expect(auditOperationLabel('UPDATE')).toBe('Changed');
    expect(auditRoleLabel('ADMIN')).toBe('Administrator');
    expect(auditRoleLabel(null)).toBeNull();
  });

  it('reads the branch from metadata, then the request', () => {
    expect(auditRowBranchId({ metadata: { branchId: 'b1' }, input: { branchId: 'b2' } })).toBe(
      'b1'
    );
    expect(auditRowBranchId({ metadata: {}, input: { scope: { branchId: 'b3' } } })).toBe('b3');
    expect(auditRowBranchId({ metadata: null, input: '[skipped]' })).toBeNull();
  });

  it('finds approvers in what was recorded, never in what was requested', () => {
    expect(
      auditApproverIds({
        metadata: { discountApproval: { approvedByUserId: 'manager_1' } },
        result: { lines: [{ approverUserId: 'pharmacist_1' }] },
        changes: { approvedById: { before: null, after: 'manager_1' } },
      })
    ).toEqual(['manager_1', 'pharmacist_1']);
    expect(
      auditApproverIds({
        metadata: null,
        result: null,
        changes: null,
        input: { approverId: 'x' },
      } as never)
    ).toEqual([]);
  });

  it('names nobody when the manager PIN was refused or the action failed', () => {
    // pharmacySales.returnLine / returnAndRefund / refundTender record the PIN
    // holder beside the verification result, before returning a blocked result.
    const refused = {
      metadata: { policy: 'REFUND_PIN', approverId: 'manager_1', pinVerified: false },
    };
    expect(auditApproverIds(refused)).toEqual([]);
    expect(
      auditApproverIds({
        metadata: { policy: 'REFUND_PIN', approverId: 'manager_1', pinVerified: true },
      })
    ).toEqual(['manager_1']);
    expect(
      auditApproverIds({
        outcome: 'FAILURE',
        metadata: { discountApproval: { approvedByUserId: 'manager_1' } },
      })
    ).toEqual([]);
    // A refused record nested beside a verified one keeps only the verified approver.
    expect(
      auditApproverIds({
        metadata: {
          first: { approverId: 'manager_1', pinVerified: false },
          second: { approvedByUserId: 'owner_1', approvalPolicy: 'PIN' },
        },
      })
    ).toEqual(['owner_1']);
  });
});
