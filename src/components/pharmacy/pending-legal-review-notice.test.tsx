import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PendingLegalReviewNotice } from './pending-legal-review-notice';

describe('PendingLegalReviewNotice', () => {
  it('distinguishes recording a profile from permission to operate', () => {
    render(<PendingLegalReviewNotice provinceName="Sindh" />);

    expect(screen.getByText('Pending legal review')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sindh rules are pending legal review. Regulatory profiles can still be recorded, but dispensing and activation remain blocked until confirmed rules and a valid profile are in force.'
    );
  });
});
