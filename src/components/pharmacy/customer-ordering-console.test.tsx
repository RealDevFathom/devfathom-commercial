import { describe, expect, it } from 'vitest';

import { customerOrderingErrorMessage } from './customer-ordering-console';

describe('customer-ordering console messages', () => {
  it('DEV-631: explains a checkout refused because the business day is closed', () => {
    const message = customerOrderingErrorMessage({ message: 'DAY_CLOSED' });
    expect(message).not.toBe('DAY_CLOSED');
    expect(message).toContain("Today's business day is closed");
    expect(message).toContain('The owner or a manager can reopen today for trading on Day close');
  });

  it('keeps an unmapped server message as it is', () => {
    expect(customerOrderingErrorMessage({ message: 'Something else' })).toBe('Something else');
  });
});
