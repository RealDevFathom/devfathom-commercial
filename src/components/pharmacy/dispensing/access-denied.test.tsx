import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  error: null as null | { message: string; data: { code: string } | null },
}));

function failedQuery() {
  return { isLoading: false, error: h.error, data: undefined };
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyDispensing: { reviewQueue: { invalidate: vi.fn() } } }),
    pharmacyDispensing: {
      reviewQueue: { useQuery: failedQuery },
      decideReview: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      substitutionWorkspace: { useQuery: failedQuery },
      recordSubstitution: { useMutation: () => ({ mutateAsync: vi.fn(), error: null }) },
    },
    pharmacySafety: {
      branches: { useQuery: failedQuery },
      controlledRegister: { useQuery: () => ({ isLoading: false, error: null, data: undefined }) },
      controlledPharmacists: { useQuery: () => ({ data: [] }) },
      recordCorrection: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

import { ControlledRegisterConsole } from './controlled-register-console';
import { isAccessDenied } from './field';
import { PharmacistQueueConsole } from './pharmacist-queue-console';
import { SubstitutionConsole } from './substitution-console';

const FORBIDDEN = {
  message: 'You do not have permission for this action.',
  data: { code: 'FORBIDDEN' },
};

beforeEach(() => {
  h.error = FORBIDDEN;
});
afterEach(cleanup);

describe('#979 a refusal reads as no access, not as a failed load', () => {
  it('recognises only FORBIDDEN as a refusal', () => {
    expect(isAccessDenied(FORBIDDEN)).toBe(true);
    expect(isAccessDenied({ data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(false);
    expect(isAccessDenied({ data: null })).toBe(false);
    expect(isAccessDenied(null)).toBe(false);
  });

  it.each([
    ['pharmacist queue', PharmacistQueueConsole, 'You do not have pharmacist review access'],
    ['substitution', SubstitutionConsole, 'You do not have substitution access'],
    ['controlled register', ControlledRegisterConsole, 'You do not have controlled-register access'],
  ] as const)('shows the %s no-access state to a cashier', (_surface, Console, heading) => {
    render(<Console />);

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByText(/Ask a workspace administrator/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    expect(screen.queryByText('No branch')).not.toBeInTheDocument();
  });

  it('keeps the failed-load state for a genuine failure', () => {
    h.error = { message: 'Network down.', data: { code: 'INTERNAL_SERVER_ERROR' } };

    render(<SubstitutionConsole />);

    expect(
      screen.getByRole('heading', { name: 'Substitution workspace could not be loaded' })
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Network down.');
  });
});
