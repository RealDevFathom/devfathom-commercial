import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { demoApproverEmail, deriveDemoApproverPin } from './approval';

describe('demo refund approver identity', () => {
  beforeEach(() => vi.stubEnv('AUTH_SECRET', 'demo-approval-test-secret'));
  afterEach(() => vi.unstubAllEnvs());

  it('uses the fixed seat email contract', () => {
    expect(demoApproverEmail(1)).toBe('approver.seat1@demo.devfathom.invalid');
    expect(demoApproverEmail(25)).toBe('approver.seat25@demo.devfathom.invalid');
    expect(() => demoApproverEmail(0)).toThrow();
    expect(() => demoApproverEmail(1.5)).toThrow();
  });

  it('derives a deterministic, separated eight-digit credential without logging it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = deriveDemoApproverPin('org_demo_restaurant_seat_1');
    const repeated = deriveDemoApproverPin('org_demo_restaurant_seat_1');
    const other = deriveDemoApproverPin('org_demo_restaurant_seat_2');

    expect(first.length).toBe(8);
    expect([...first].every((character) => character >= '0' && character <= '9')).toBe(true);
    expect(first === repeated).toBe(true);
    expect(first === other).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('fails closed when the server secret is missing', () => {
    vi.stubEnv('AUTH_SECRET', '');
    expect(() => deriveDemoApproverPin('org_demo_restaurant_seat_1')).toThrow(
      'AUTH_SECRET is required for demo approval.'
    );
  });
});
