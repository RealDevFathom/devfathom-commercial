import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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

import { CounterRxPanel } from './counter-rx-panel';

describe('cashier prescription intake', () => {
  it('does not link the production fallback action to the dispense-only workspace', () => {
    mocks.captureWorkspace.mockReturnValue({ data: { medicines: [], prescribers: [] } });
    render(
      <CounterRxPanel
        alerts={[]}
        patient={{
          patientId: 'patient-a',
          displayName: 'Patient A',
          phone: null,
          cnic: null,
          dispensingConsent: true,
          address: null,
          prescriptions: [],
        }}
        candidates={[]}
        query=""
        state="ready"
        onQueryChange={vi.fn()}
        onSearch={vi.fn()}
        onSelectPatient={vi.fn()}
        onClearPatient={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Capture prescription' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: /Capture prescription/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Use Photograph prescription below/)).toBeInTheDocument();
  });

  it('offers enabled capture controls before any upload and opens the narrow intake workspace', async () => {
    mocks.captureWorkspace.mockReturnValue({ data: { medicines: [], prescribers: [] } });
    render(
      <CounterRxPanel
        alerts={[]}
        patient={{
          patientId: 'patient-a',
          displayName: 'Patient A',
          phone: null,
          cnic: null,
          dispensingConsent: true,
          address: null,
          prescriptions: [],
        }}
        candidates={[]}
        query=""
        state="ready"
        onQueryChange={vi.fn()}
        onSearch={vi.fn()}
        onSelectPatient={vi.fn()}
        onClearPatient={vi.fn()}
        onCapturePrescription={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Capture prescription' })).toBeEnabled();
    const photograph = screen.getByRole('button', { name: 'Photograph prescription' });
    expect(photograph).toBeEnabled();
    expect(mocks.captureWorkspace).toHaveBeenLastCalledWith(undefined, { enabled: false });

    await userEvent.click(photograph);
    expect(screen.getByRole('form', { name: 'Photograph prescription' })).toBeInTheDocument();
    expect(mocks.captureWorkspace).toHaveBeenLastCalledWith(undefined, { enabled: true });
  });
});
