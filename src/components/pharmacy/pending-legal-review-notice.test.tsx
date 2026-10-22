import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PendingLegalReviewNotice } from './pending-legal-review-notice';

describe('PendingLegalReviewNotice', () => {
  it('announces the pending state with a visible warning badge and explanation', () => {
    render(<PendingLegalReviewNotice message="Sindh rules are awaiting confirmation." />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Pending legal review');
    expect(notice).toHaveTextContent('Sindh rules are awaiting confirmation.');
    expect(notice.querySelector('[data-tone="warning"]')).not.toBeNull();
  });
});
