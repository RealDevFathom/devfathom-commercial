import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ canViewPatients: false }));

function line(patient: { id: string; displayName: string } | null) {
  return {
    id: 'review-1',
    prescriptionLineId: 'rx-line',
    saleLineId: 'sale-line',
    line: {
      presentationId: 'tab-10',
      medicine: { productName: 'Medicine A', presentations: [] },
      presentation: { id: 'tab-10', presentation: 'Tablet 10mg' },
      prescription: { patient },
    },
  };
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyDispensing: {
      substitutionWorkspace: {
        useQuery: () => ({
          isLoading: false,
          error: null,
          data: {
            canRecord: false,
            canViewPatients: h.canViewPatients,
            lines: [
              line(h.canViewPatients ? { id: 'patient-1', displayName: 'Patient One' } : null),
            ],
          },
        }),
      },
      recordSubstitution: {
        useMutation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
      },
    },
  },
}));

import { SubstitutionConsole } from './substitution-console';

afterEach(cleanup);

describe('QA-7 substitution screen patient records', () => {
  it('hides patient records from a caller without the patient-record permission', () => {
    h.canViewPatients = false;

    render(<SubstitutionConsole />);

    expect(screen.getByRole('option', { hidden: true, name: 'Medicine A · Tablet 10mg' })).toBeInTheDocument();
    expect(screen.getByRole('option', { hidden: true, name: 'Select medicine' })).toBeInTheDocument();
    expect(screen.queryByText(/Patient One/)).not.toBeInTheDocument();
    expect(screen.getByText(/Patient names are hidden/)).toBeInTheDocument();
  });

  it('shows the patient name to a holder of the patient-record permission', () => {
    h.canViewPatients = true;

    render(<SubstitutionConsole />);

    expect(
      screen.getByRole('option', { hidden: true, name: 'Patient One · Medicine A · Tablet 10mg' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/Patient names are hidden/)).not.toBeInTheDocument();
  });
});
