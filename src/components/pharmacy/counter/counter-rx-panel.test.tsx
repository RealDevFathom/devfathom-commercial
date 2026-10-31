import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ captureWorkspace: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyPrescriptions: {
        counterPatientPanel: { invalidate: vi.fn() },
        captureWorkspace: { invalidate: vi.fn() },
      },
    }),
    pharmacyPrescriptions: {
      captureWorkspace: { useQuery: mocks.captureWorkspace },
      uploadSource: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
      extractSource: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
      capture: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
    },
  },
}));

import { CounterRxPanel, type CounterRxPanelProps } from './counter-rx-panel';

function panelProps(): CounterRxPanelProps {
  return {
    alerts: [],
    patient: {
      patientId: 'patient/a',
      displayName: 'Patient A',
      phone: null,
      cnic: null,
      dispensingConsent: true,
      address: null,
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
}

describe('cashier prescription intake', () => {
  beforeEach(() => {
    mocks.captureWorkspace.mockReturnValue({ data: { medicines: [], prescribers: [] } });
  });

  it('offers photo capture without a dead button or dispense-only workspace link', () => {
    render(<CounterRxPanel {...panelProps()} />);

    expect(screen.queryByRole('button', { name: 'Capture prescription' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /pharmacist workspace/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Photograph prescription' })).toBeEnabled();
    expect(screen.getByText(/Photograph the prescription below/)).toBeInTheDocument();
  });

  it('offers enabled capture controls before any upload and opens the narrow intake workspace', () => {
    const onCapturePrescription = vi.fn();
    render(<CounterRxPanel {...panelProps()} onCapturePrescription={onCapturePrescription} />);

    const capture = screen.getByRole('button', { name: 'Capture prescription' });
    expect(capture).toBeEnabled();
    fireEvent.click(capture);
    expect(onCapturePrescription).toHaveBeenCalledWith({ patientId: 'patient/a' });
    const photograph = screen.getByRole('button', { name: 'Photograph prescription' });
    expect(photograph).toBeEnabled();
    expect(mocks.captureWorkspace).toHaveBeenLastCalledWith(undefined, { enabled: false });

    fireEvent.click(photograph);
    expect(screen.getByRole('form', { name: 'Photograph prescription' })).toBeInTheDocument();
    expect(mocks.captureWorkspace).toHaveBeenLastCalledWith(undefined, { enabled: true });
  });

  it('lets dispensing staff open the patient workspace in another tab while keeping photo capture', () => {
    render(<CounterRxPanel {...panelProps()} canDispense />);

    const link = screen.getByRole('link', { name: /Open pharmacist workspace for Patient A/ });
    expect(link).toHaveAttribute('href', '/pharmacy/prescriptions#patientId=patient%2Fa');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Photograph prescription' })).toBeEnabled();
  });

  it.each(['loading', 'error', 'denied'] as const)(
    'does not offer workspace navigation during the %s state',
    (state) => {
      render(<CounterRxPanel {...panelProps()} canDispense state={state} />);
      expect(screen.queryByRole('link', { name: /pharmacist workspace/ })).not.toBeInTheDocument();
      const photograph = screen.queryByRole('button', { name: 'Photograph prescription' });
      if (photograph) expect(photograph).toBeDisabled();
    }
  );

  it('disables capture and hides workspace navigation when the bill is busy', () => {
    render(<CounterRxPanel {...panelProps()} canDispense disabled />);
    expect(screen.queryByRole('link', { name: /pharmacist workspace/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Photograph prescription' })).toBeDisabled();
  });
});
