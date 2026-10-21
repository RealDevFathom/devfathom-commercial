import { describe, expect, it } from 'vitest';

import {
  classifyTerminalFailure,
  isValidPin,
  sanitizePin,
  validateCoAuthorization,
} from './terminal-state';

describe('terminal credential and failure guards', () => {
  it('keeps PIN input numeric and enforces the server 4–8 digit policy', () => {
    expect(sanitizePin('12a 34-567890')).toBe('12345678');
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('12345678')).toBe(true);
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('123456789')).toBe(false);
  });

  it('requires distinct identities and paired target evidence for manager approval', () => {
    const approval = {
      actingStaffProfileId: 'staff-1',
      approvingStaffProfileId: 'staff-1',
      pin: '4821',
      capability: 'orders:void',
      reason: 'Duplicate order',
      targetType: 'Order',
      targetId: 'order-7',
    };
    expect(validateCoAuthorization(approval)).toMatch(/must differ/);
    expect(
      validateCoAuthorization({
        ...approval,
        approvingStaffProfileId: 'staff-2',
        targetId: '',
      })
    ).toMatch(/both target type and target ID/);
    expect(validateCoAuthorization({ ...approval, approvingStaffProfileId: 'staff-2' })).toBeNull();
  });

  it('maps transport failures without returning server-provided secret text', () => {
    expect(classifyTerminalFailure(401, 'Terminal session is no longer valid.')).toMatchObject({
      kind: 'unauthorized',
      reset: 'session',
    });
    expect(classifyTerminalFailure(403, 'This device has been revoked.')).toMatchObject({
      kind: 'revoked',
      reset: 'device',
    });
    expect(classifyTerminalFailure(423, 'secret=4821', '42')).toMatchObject({
      kind: 'locked',
      message: 'Server requires a 42-second wait before another attempt.',
    });
  });
});
