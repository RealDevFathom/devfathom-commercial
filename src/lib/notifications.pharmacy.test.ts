import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', () => ({ sendEmail: vi.fn() }));

import { categoryForType, NOTIFICATION_CATEGORIES } from './notifications';

describe('pharmacy notification categories', () => {
  it('registers stock, expiry, approval and refund', () => {
    expect(NOTIFICATION_CATEGORIES).toEqual(
      expect.arrayContaining(['stock', 'expiry', 'approval', 'refund'])
    );
  });

  it('maps pharmacy notification types onto their category', () => {
    expect(categoryForType('stock_low')).toBe('stock');
    expect(categoryForType('expiry_near')).toBe('expiry');
    expect(categoryForType('approval_requested')).toBe('approval');
    expect(categoryForType('refund_issued')).toBe('refund');
  });
});
