import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CounterRxPanel, type CounterRxPanelProps } from './counter-rx-panel';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    pharmacyPrescriptions: {
      workspace: { useQuery: () => ({}) },
      uploadSource: { useMutation: () => ({}) },
      extractSource: { useMutation: () => ({}) },
      capture: { useMutation: () => ({}) },
    },
  },
}));

const props: CounterRxPanelProps = {
  alerts: [],
  patient: {
    patientId: 'patient-1',
    displayName: 'Patient',
    phone: null,
    cnic: null,
    dispensingConsent: true,
    prescriptions: [],
  },
  candidates: [],
  query: '',
  state: 'ready',
  onQueryChange: vi.fn(),
  onSearch: vi.fn(),
  onSelectPatient: vi.fn(),
  onClearPatient: vi.fn(),
};

describe('counter prescription capture permission', () => {
  it('shows a patient mismatch only after a patient is attached', () => {
    const mismatch = {
      key: 'rx-patient-mismatch:line-1',
      severity: 'SAFETY_BLOCK' as const,
      code: 'PRESCRIPTION_PATIENT_MISMATCH',
      message: 'This prescription is not for the patient linked to this sale.',
      saleLineRef: 'line-1',
      remedy: 'Link the correct patient.',
    };

    const { rerender } = render(<CounterRxPanel {...props} patient={null} alerts={[mismatch]} />);
    expect(screen.queryByText(mismatch.message)).not.toBeInTheDocument();

    rerender(<CounterRxPanel {...props} alerts={[mismatch]} />);
    expect(screen.getByText(mismatch.message)).toBeInTheDocument();
  });

  it('hides capture and photo upload from cashiers even with a capture callback', () => {
    render(<CounterRxPanel {...props} onCapturePrescription={vi.fn()} />);
    expect(screen.queryByText('Capture prescription')).not.toBeInTheDocument();
    expect(screen.queryByText('Photograph prescription')).not.toBeInTheDocument();
    expect(screen.getByText('No prescription is on file for this patient.')).toBeInTheDocument();
  });

  it('shows capture to an authorized pharmacist', () => {
    render(<CounterRxPanel {...props} canCapturePrescription />);
    expect(screen.getByRole('link', { name: /Capture prescription/ })).toHaveAttribute(
      'href',
      '/pharmacy/prescriptions#patientId=patient-1'
    );
  });
});
