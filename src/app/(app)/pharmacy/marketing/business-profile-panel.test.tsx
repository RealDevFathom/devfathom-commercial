import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('uses an owner-configured target and makes manual-only drafting explicit', async () => {
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
    fireEvent.change(screen.getByLabelText('Your photo freshness target (days)'), {
      target: { value: '' },
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter whole numbers');

    fireEvent.click(screen.getByLabelText('Business name matches storefront'));
    await waitFor(() =>
      expect(localStorage.getItem('pharmacy-business-profile-health:branch-1')).toContain('name')
    );
  });

  it('restores branch-specific health evidence from device storage', async () => {
    localStorage.setItem(
      'pharmacy-business-profile-health:branch-saved',
      JSON.stringify({ checkedItems: ['hours'], photoAge: '4', photoTarget: '20' })
    );
    render(<BusinessProfilePanel branchId="branch-saved" />);
    await waitFor(() =>
      expect(screen.getByLabelText('Regular and holiday hours are current')).toBeChecked()
    );
    expect(screen.getByLabelText('Days since latest photo')).toHaveValue(4);
    expect(screen.getByRole('status')).toHaveTextContent('within your configured target');
  });
});
