import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PendingLegalReviewNotice } from './pending-legal-review-notice';

describe('PendingLegalReviewNotice', () => {
  it('clearly labels the pending state without claiming that record creation is blocked', () => {
    render(<PendingLegalReviewNotice provinceName="Sindh" />);

    expect(screen.getByText('Pending legal review')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sindh rules are pending legal review. Records can still be created, but these provincial rules are not enforced until legal sign-off.'
    );
  });
});
