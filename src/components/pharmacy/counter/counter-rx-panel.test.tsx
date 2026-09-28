import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CounterRxPanel, type CounterRxPanelProps } from './counter-rx-panel';

afterEach(cleanup);

const patient = {
  patientId: 'patient/one',
  displayName: 'Test patient',
  phone: '***1234',
  cnic: null,
  dispensingConsent: false,
  prescriptions: [],
};

function props(overrides: Partial<CounterRxPanelProps> = {}): CounterRxPanelProps {
  return {
    patient,
    alerts: [
      {
        key: 'rx',
        severity: 'SAFETY_BLOCK',
        code: 'RX_REQUIRED',
        message: 'Prescription required.',
        saleLineRef: null,
        remedy: 'Capture the prescription for review.',
      },
    ],
    candidates: [],
    query: '',
    state: 'ready',
    onQueryChange: vi.fn(),
    onSearch: vi.fn(),
    onSelectPatient: vi.fn(),
    onClearPatient: vi.fn(),
    ...overrides,
  };
}

describe('CounterRxPanel prescription capture', () => {
  it('offers a patient-aware capture link while keeping the bill and clinical block intact', () => {
    render(<CounterRxPanel {...props()} />);
    const action = screen.getByRole('link', { name: /Capture prescription/ });
    expect(action).toHaveAttribute('href', '/pharmacy/prescriptions#patientId=patient%2Fone');
    expect(action).toHaveAttribute('target', '_blank');
    expect(action).toHaveAttribute('rel', 'noopener noreferrer');
    expect(action).toHaveAccessibleName(/Test patient.*new tab/);
    expect(screen.getByRole('alert')).toHaveTextContent('Prescription required.');
    expect(screen.getByText('No consent on file')).toBeVisible();
    expect(screen.queryByRole('button', { name: /sign|approve|override/i })).toBeNull();
  });

  it('hands only the selected patient id to an embedded capture callback', () => {
    const onCapturePrescription = vi.fn();
    render(<CounterRxPanel {...props({ onCapturePrescription })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture prescription' }));
    expect(onCapturePrescription).toHaveBeenCalledExactlyOnceWith({ patientId: patient.patientId });
    expect(screen.queryByRole('link', { name: /Capture prescription/ })).toBeNull();
  });

  it.each(['loading', 'error'] as const)('disables capture during %s', (state) => {
    const onCapturePrescription = vi.fn();
    render(<CounterRxPanel {...props({ state, onCapturePrescription })} />);
    const action = screen.getByRole('button', { name: 'Capture prescription' });
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(onCapturePrescription).not.toHaveBeenCalled();
  });

  it('allows capture for a loaded patient even without an active search', () => {
    render(<CounterRxPanel {...props({ state: 'idle' })} />);
    expect(screen.getByRole('link', { name: /Capture prescription/ })).toHaveAttribute(
      'href',
      '/pharmacy/prescriptions#patientId=patient%2Fone'
    );
  });

  it('disables the default action while the counter is locked', () => {
    render(<CounterRxPanel {...props({ disabled: true })} />);
    expect(screen.getByRole('button', { name: 'Capture prescription' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: /Capture prescription/ })).toBeNull();
  });

  it('shows the patient selection step before capture', () => {
    render(<CounterRxPanel {...props({ patient: null })} />);
    expect(screen.getByText('Select a patient to capture their prescription.')).toBeVisible();
    expect(screen.getByLabelText('Find patient')).toBeEnabled();
    expect(screen.queryByRole('link', { name: /Capture prescription/ })).toBeNull();
  });

  it('does not offer capture when prescription access is denied', () => {
    render(<CounterRxPanel {...props({ state: 'denied', onCapturePrescription: vi.fn() })} />);
    expect(screen.getByText(/Prescriptions are not enabled/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Capture prescription' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Capture prescription/ })).toBeNull();
  });
});
