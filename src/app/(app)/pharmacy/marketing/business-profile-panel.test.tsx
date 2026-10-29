import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./action-form', () => ({
  MarketingActionForm: ({
    children,
    operation,
  }: {
    children: React.ReactNode;
    operation: string;
  }) => <form data-operation={operation}>{children}</form>,
}));

import { BusinessProfilePanel } from './business-profile-panel';

describe('BusinessProfilePanel', () => {
  it('uses an owner-configured target and makes manual-only drafting explicit', () => {
    render(<BusinessProfilePanel branchId="branch-1" />);

    expect(screen.getByText(/Nothing is auto-posted/i)).toBeInTheDocument();
    expect(screen.getByText(/does not change or publish profile data/i)).toBeInTheDocument();
    expect(screen.getByText('Business name matches storefront')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Days since latest photo'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Your photo freshness target (days)'), {
      target: { value: '10' },
    });
    expect(screen.getByRole('status')).toHaveTextContent('needs attention');
    expect(document.querySelector('[data-operation="review-reply"]')).toBeInTheDocument();
  });
});
