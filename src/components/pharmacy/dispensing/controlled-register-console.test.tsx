import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySafety: {
      branches: {
        useQuery: () => ({
          data: [{ id: 'branch_1', name: 'Karachi branch' }],
          error: null,
        }),
      },
      controlledRegister: { useQuery: (...args: unknown[]) => mocks.register(...args) },
      controlledPharmacists: { useQuery: () => ({ data: [] }) },
      recordCorrection: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

import { ControlledRegisterConsole } from './controlled-register-console';

afterEach(cleanup);

beforeEach(() => {
  mocks.register.mockReset();
  mocks.register.mockReturnValue({
    data: { entries: [], pendingLegalReview: false },
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  });
});

describe('ControlledRegisterConsole legal-review status', () => {
  it('shows that pending rules still allow sales', () => {
    mocks.register.mockReturnValue({
      data: { entries: [], pendingLegalReview: true },
      error: null,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<ControlledRegisterConsole />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Pending legal review');
    expect(status).toHaveTextContent(
      'These controlled-register rules are pending legal review. Sales are allowed.'
    );
  });

  it('does not show the review status for confirmed rules', () => {
    render(<ControlledRegisterConsole />);

    expect(screen.queryByText('Pending legal review')).not.toBeInTheDocument();
  });
});
