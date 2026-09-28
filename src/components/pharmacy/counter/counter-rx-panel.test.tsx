import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  upload: vi.fn(),
  extract: vi.fn(),
  capture: vi.fn(),
  invalidatePanel: vi.fn(),
  invalidateWorkspace: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyPrescriptions: {
        counterPatientPanel: { invalidate: mocks.invalidatePanel },
        workspace: { invalidate: mocks.invalidateWorkspace },
      },
    }),
    pharmacyPrescriptions: {
      workspace: { useQuery: mocks.workspace },
      uploadSource: { useMutation: () => ({ mutateAsync: mocks.upload, isPending: false }) },
      extractSource: { useMutation: () => ({ mutateAsync: mocks.extract, isPending: false }) },
      capture: { useMutation: () => ({ mutateAsync: mocks.capture, isPending: false }) },
    },
  },
}));

import { CounterRxPanel, type CounterRxPanelProps } from './counter-rx-panel';

afterEach(cleanup);

const fileId = '12345678-1234-4123-8123-123456789abc';
const privateUrl = `/api/pharmacy/prescription-files?id=${fileId}`;

beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => 'blob:rx-preview');
  URL.revokeObjectURL = vi.fn();
  mocks.workspace.mockReturnValue({
    isLoading: false,
    error: null,
    data: {
      prescribers: [{ id: 'prescriber-one', name: 'Dr Test', registrationNumber: 'PMDC-1' }],
      medicines: [
        {
          id: 'medicine-rx',
          productName: 'Fathomcillin E2E',
          presentations: [{ id: 'presentation-rx', presentation: 'Capsule' }],
        },
      ],
    },
  });
  mocks.upload.mockImplementation(async ({ contentType }) => ({
    url: privateUrl,
    sourceFileRef: privateUrl,
    size: 8,
    contentType,
  }));
  mocks.capture.mockResolvedValue({ id: `rx-${fileId}` });
  mocks.invalidatePanel.mockResolvedValue(undefined);
  mocks.invalidateWorkspace.mockResolvedValue(undefined);
});

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

const photo = (type = 'image/png', name = 'rx.png') =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type });

function openPhotoCapture() {
  render(<CounterRxPanel {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Photograph prescription' }));
  return screen.getByRole('form', { name: 'Photograph prescription' });
}

function choosePhoto(file = photo()) {
  fireEvent.change(screen.getByLabelText('Prescription photo'), { target: { files: [file] } });
}

function fillRequired(form: HTMLElement, { directions = true } = {}) {
  const field = within(form);
  fireEvent.change(field.getByLabelText('Prescriber'), { target: { value: 'prescriber-one' } });
  fireEvent.change(field.getByLabelText('Medicine'), { target: { value: 'medicine-rx' } });
  fireEvent.change(field.getByLabelText('Presentation'), { target: { value: 'presentation-rx' } });
  fireEvent.change(field.getByLabelText('Authorized units'), { target: { value: '15' } });
  if (directions)
    fireEvent.change(field.getByLabelText('Directions'), { target: { value: 'One capsule tds' } });
}

describe('CounterRxPanel photo capture (PH-A3)', () => {
  it('offers a rear-camera image input and loads the capture directory only when opened', () => {
    render(<CounterRxPanel {...props()} />);
    expect(mocks.workspace).toHaveBeenLastCalledWith(undefined, { enabled: false });
    fireEvent.click(screen.getByRole('button', { name: 'Photograph prescription' }));
    expect(mocks.workspace).toHaveBeenLastCalledWith(undefined, { enabled: true });
    const input = screen.getByLabelText('Prescription photo');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input).toHaveAttribute('capture', 'environment');
  });

  it('stores the photo privately, binds it to the capture and shows the saved thumbnail', async () => {
    const form = openPhotoCapture();
    choosePhoto();
    expect(screen.getByAltText('Selected prescription photo')).toHaveAttribute(
      'src',
      'blob:rx-preview'
    );
    fillRequired(form);
    fireEvent.submit(form);

    await waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    expect(mocks.upload).toHaveBeenCalledWith({
      patientId: 'patient/one',
      contentType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        patientId: 'patient/one',
        prescriberId: 'prescriber-one',
        sourceKind: 'PAPER_IMAGE',
        sourceFileRef: privateUrl,
        authorizedRepeats: 0,
        lines: [
          {
            lineNumber: 1,
            medicineId: 'medicine-rx',
            presentationId: 'presentation-rx',
            authorizedCanonicalUnits: 15,
            directions: 'One capsule tds',
          },
        ],
      })
    );
    const saved = await screen.findByAltText('Saved prescription photo for Test patient');
    expect(saved).toHaveAttribute('src', privateUrl);
    expect(screen.getByRole('status')).toHaveTextContent(/pharmacist must still sign/i);
    expect(mocks.invalidatePanel).toHaveBeenCalledWith({ patientId: 'patient/one' });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('refuses a photo format the private store will not accept, before upload', () => {
    const form = openPhotoCapture();
    choosePhoto(photo('image/heic', 'rx.heic'));
    expect(within(form).getByRole('alert')).toHaveTextContent(/JPEG, PNG or WebP/);
    expect(within(form).getByRole('button', { name: 'Save prescription' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Suggest from photo' })).toBeNull();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('OCR prefill is only a proposal: nothing applies until chosen, then it must be confirmed', async () => {
    mocks.extract.mockResolvedValue({
      status: 'PROPOSED',
      requiresPharmacistConfirmation: true,
      adapter: 'FIXTURE',
      adapterVersion: 'fixture',
      lines: [
        {
          drugName: { value: 'Fathomcillin', confidence: 0.91 },
          strength: { value: '250 mg', confidence: 0.88 },
          dose: { value: '1 capsule every 8 hours for 5 days', confidence: 0.64 },
          medicineCandidates: [{ medicineId: 'medicine-rx', label: 'Fathomcillin E2E' }],
        },
      ],
    });
    const form = openPhotoCapture();
    choosePhoto();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest from photo' }));
    const suggestions = await screen.findByRole('region', { name: 'Suggestions from photo' });
    expect(mocks.extract).toHaveBeenCalledWith({ sourceFileRef: privateUrl });
    expect(suggestions).toHaveTextContent('Read: Fathomcillin 250 mg');

    // Never auto-applied.
    expect(within(form).getByLabelText('Medicine')).toHaveValue('');
    expect(within(form).getByLabelText('Directions')).toHaveValue('');
    expect(within(form).queryByRole('checkbox')).toBeNull();

    fireEvent.click(within(suggestions).getByRole('button', { name: /Use medicine Fathomcillin/ }));
    fireEvent.click(within(suggestions).getByRole('button', { name: /Use directions/ }));
    expect(within(form).getByLabelText('Medicine')).toHaveValue('medicine-rx');
    expect(within(form).getByLabelText('Directions')).toHaveValue(
      '1 capsule every 8 hours for 5 days'
    );

    fillRequired(form, { directions: false });
    const save = within(form).getByRole('button', { name: 'Save prescription' });
    expect(save).toBeDisabled();
    fireEvent.submit(form);
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      /Confirm the suggested values/
    );
    expect(mocks.capture).not.toHaveBeenCalled();

    fireEvent.click(within(form).getByRole('checkbox', { name: /checked the suggested/ }));
    expect(save).toBeEnabled();
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce());
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.capture.mock.calls[0][0].lines[0]).toMatchObject({
      medicineId: 'medicine-rx',
      directions: '1 capsule every 8 hours for 5 days',
    });
  });

  it('reports OCR being off or failing without touching the form', async () => {
    mocks.extract.mockRejectedValue(
      new Error('Prescription reading is not enabled for this workspace.')
    );
    const form = openPhotoCapture();
    choosePhoto();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest from photo' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/not enabled/);
    expect(within(form).getByLabelText('Medicine')).toHaveValue('');
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('keeps the photo and form for retry when capture fails', async () => {
    mocks.capture.mockRejectedValueOnce(new Error('Patient or prescriber not found.'));
    const form = openPhotoCapture();
    choosePhoto();
    fillRequired(form);
    fireEvent.submit(form);
    expect(await within(form).findByRole('alert')).toHaveTextContent(/kept for retry/);
    expect(within(form).getByLabelText('Medicine')).toHaveValue('medicine-rx');
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(2));
    expect(mocks.upload).toHaveBeenCalledOnce();
  });

  it('shows a private thumbnail for photo-backed prescriptions only', () => {
    const prescription = (prescriptionId: string, prescriberName: string) => ({
      prescriptionId,
      prescriberName,
      sourceKind: 'PAPER_IMAGE',
      custodyState: 'NOT_HELD',
      validFrom: '2026-09-01T00:00:00.000Z',
      validUntil: '2026-10-01T00:00:00.000Z',
      inDate: true,
      authorizedRepeats: 0,
      lines: [],
    });
    render(
      <CounterRxPanel
        {...props({
          patient: {
            ...patient,
            prescriptions: [
              prescription(`rx-${fileId}`, 'Dr Photo'),
              prescription('prescription_seed', 'Dr Legacy'),
            ],
          },
        })}
      />
    );
    expect(screen.getByAltText('Prescription photo from Dr Photo')).toHaveAttribute(
      'src',
      privateUrl
    );
    expect(screen.queryByAltText('Prescription photo from Dr Legacy')).toBeNull();
  });
});
