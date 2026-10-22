import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CounterPatientPanel } from '@/lib/pharmacy/counter-prescriptions';

const mocks = vi.hoisted(() => ({ workspace: vi.fn(), mutation: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyPrescriptions: {
        counterPatientPanel: { invalidate: vi.fn() },
        workspace: { invalidate: vi.fn() },
      },
    }),
    pharmacyPrescriptions: {
      workspace: {
        useQuery: (input: unknown, options: unknown) => {
          mocks.workspace(input, options);
          return { data: undefined, isLoading: false, error: null };
        },
      },
      uploadSource: { useMutation: () => ({ mutateAsync: mocks.mutation, isPending: false }) },
      extractSource: { useMutation: () => ({ mutateAsync: mocks.mutation, isPending: false }) },
      capture: { useMutation: () => ({ mutateAsync: mocks.mutation, isPending: false }) },
    },
  },
}));

import { CounterRxPanel, type CounterRxPanelProps } from './counter-rx-panel';

const patient: CounterPatientPanel = {
  patientId: 'patient-a',
  displayName: 'Ayesha Karim',
  cnic: '*****-*******-1',
  phone: '*******1234',
  dispensingConsent: true,
  address: null,
  prescriptions: [
    {
      prescriptionId: 'rx-11111111-1111-4111-8111-111111111111',
      prescriberName: 'Dr Khan',
      sourceKind: 'PAPER_IMAGE',
      custodyState: 'NOT_HELD',
      validFrom: '2026-10-01T00:00:00.000Z',
      validUntil: '2026-11-01T00:00:00.000Z',
      inDate: true,
      authorizedRepeats: 0,
      lines: [
        {
          prescriptionLineId: 'line-1',
          lineNumber: 1,
          medicineId: 'medicine-1',
          medicineName: 'Amoxicillin',
          presentationId: 'presentation-1',
          presentation: 'Capsule',
          directions: 'Twice daily',
          authorizedCanonicalUnits: 10,
          filledCanonicalUnits: 0,
          remainingAuthorizedUnits: 10,
          verified: false,
          latestDecision: null,
        },
      ],
    },
  ],
};

function renderPanel(props: Partial<CounterRxPanelProps> = {}) {
  return render(
    <CounterRxPanel
      alerts={[]}
      patient={patient}
      candidates={[]}
      query=""
      state="ready"
      onQueryChange={vi.fn()}
      onSearch={vi.fn()}
      onSelectPatient={vi.fn()}
      onClearPatient={vi.fn()}
      {...props}
    />
  );
}

beforeEach(() => vi.clearAllMocks());

describe('counter prescription capture visibility (#238)', () => {
  it.each([
    ['without the capture decision', {}],
    ['when the server refuses capture', { canCapturePrescriptions: false }],
  ])('offers no capture or photo to a cashier %s', (_label, props) => {
    renderPanel(props);
    expect(screen.queryByRole('link', { name: /Capture prescription/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Capture prescription/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Photograph prescription' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Photograph prescription' })).toBeNull();
    // The image route would refuse this user, so no broken thumbnail either.
    expect(screen.queryByAltText('Prescription photo from Dr Khan')).toBeNull();
    expect(
      screen.getByText(/Prescription capture needs the pharmacist dispensing permission/)
    ).toHaveTextContent('Ask a pharmacist to capture Ayesha Karim');
    // The prescription itself is still listed for the bill.
    expect(screen.getByText('Amoxicillin')).toBeVisible();
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it('offers capture, the photo flow and thumbnails to someone the server allows', () => {
    renderPanel({ canCapturePrescriptions: true });
    expect(screen.getByRole('link', { name: /Capture prescription/ })).toHaveAttribute(
      'href',
      '/pharmacy/prescriptions#patientId=patient-a'
    );
    expect(screen.getByRole('button', { name: 'Photograph prescription' })).toBeEnabled();
    expect(screen.getByAltText('Prescription photo from Dr Khan')).toHaveAttribute(
      'src',
      '/api/pharmacy/prescription-files?id=11111111-1111-4111-8111-111111111111'
    );
    expect(screen.queryByText(/needs the pharmacist dispensing permission/)).toBeNull();
  });

  it('words the patient search for checking, not capturing, when capture is refused', () => {
    renderPanel({ patient: null });
    expect(screen.getByText('Select a patient to check their prescriptions.')).toBeVisible();
    renderPanel({ patient: null, canCapturePrescriptions: true });
    expect(screen.getByText('Select a patient to capture their prescription.')).toBeVisible();
  });
});
