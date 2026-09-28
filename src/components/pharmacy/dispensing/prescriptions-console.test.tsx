import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrescriptionsConsole } from './prescriptions-console';

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  capture: vi.fn(),
  upload: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyPrescriptions: { workspace: { invalidate: mocks.invalidate } } }),
    pharmacyPrescriptions: {
      workspace: { useQuery: mocks.workspace },
      capture: { useMutation: () => ({ mutateAsync: mocks.capture, isPending: false }) },
      uploadSource: { useMutation: () => ({ mutateAsync: mocks.upload, isPending: false }) },
      captureRefillReminder: { useMutation: () => ({ isPending: false }) },
    },
  },
}));

const privateUrl = '/api/pharmacy/prescription-files?id=12345678-1234-4123-8123-123456789abc';
const file = () =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'prescription.png', {
    type: 'image/png',
  });
const response = (source: File, url = privateUrl) => ({
  url,
  sourceFileRef: url,
  size: source.size,
  contentType: source.type,
});

function workspace() {
  return {
    patients: [
      { id: 'patient/one', displayName: 'First patient', phone: null },
      { id: 'patient-two', displayName: 'Second patient', phone: null },
    ],
    prescribers: [{ id: 'prescriber-one', name: 'Prescriber', registrationNumber: 'TEST' }],
    medicines: [
      {
        id: 'medicine-one',
        productName: 'Medicine',
        presentations: [{ id: 'presentation-one', presentation: 'TABLET' }],
      },
    ],
    prescriptions: [],
    branches: [],
    reminderCaptures: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockReturnValue({ data: workspace(), isLoading: false, error: null });
  mocks.capture.mockReset().mockResolvedValue({ id: 'saved-prescription' });
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
  mocks.upload.mockReset();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillForm(source = file()) {
  fireEvent.change(screen.getByLabelText('Prescriber'), { target: { value: 'prescriber-one' } });
  fireEvent.change(screen.getByLabelText('Medicine'), { target: { value: 'medicine-one' } });
  fireEvent.change(screen.getByLabelText('Presentation'), {
    target: { value: 'presentation-one' },
  });
  fireEvent.change(screen.getByLabelText('Valid until'), { target: { value: '2030-01-01' } });
  fireEvent.change(screen.getByLabelText('Authorized units'), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText('Directions'), { target: { value: 'One tablet daily' } });
  fireEvent.change(screen.getByLabelText(/Prescription image/), { target: { files: [source] } });
  return source;
}

function submit() {
  fireEvent.submit(screen.getByRole('form', { name: 'Capture prescription' }));
}

describe('PrescriptionsConsole durable evidence capture', () => {
  it('consumes the counter patient fragment without creating consent or clinical approval', () => {
    window.history.replaceState(null, '', '/#patientId=patient%2Fone');
    render(<PrescriptionsConsole />);
    expect(screen.getByLabelText('Patient')).toHaveValue('patient/one');
    expect(screen.getByText('Capturing for First patient.')).toBeVisible();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('requires a fresh selection when the handed-off patient is unavailable', () => {
    render(<PrescriptionsConsole initialPatientId="inaccessible" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'patient passed from the counter is unavailable'
    );
    expect(screen.getByLabelText('Patient')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Capture prescription' })).toBeDisabled();
  });

  it('sends actual file bytes before capture, locks pending input, and exposes the saved attachment', async () => {
    let finishUpload!: (value: ReturnType<typeof response>) => void;
    mocks.upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpload = resolve;
        })
    );
    render(<PrescriptionsConsole initialPatientId="patient/one" />);
    const source = fillForm();
    submit();
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect(mocks.upload).toHaveBeenCalledWith({
      patientId: 'patient/one',
      contentType: 'image/png',
      dataBase64: 'iVBORw0KGgo=',
    });
    const bytes = Uint8Array.from(atob(mocks.upload.mock.calls[0][0].dataBase64), (character) =>
      character.charCodeAt(0)
    );
    expect(Array.from(bytes)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(screen.getByRole('progressbar', { name: 'Uploading attachment' })).toBeVisible();
    expect(screen.getByLabelText('Directions')).toBeDisabled();
    submit();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    await act(async () => finishUpload(response(source)));
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ patientId: 'patient/one', sourceFileRef: privateUrl })
    );
    expect(mocks.capture.mock.calls[0][0].sourceFileRef).not.toMatch(/^capture:/);
    expect(await screen.findByRole('link', { name: /View saved attachment/ })).toHaveAttribute(
      'href',
      privateUrl
    );
    expect(screen.getByText(/Pharmacist review and dispensing consent still apply/)).toBeVisible();
    expect(screen.getByLabelText('Directions')).toHaveValue('');
    expect(screen.getByLabelText('Medicine')).toHaveValue('');
  });

  it.each([
    ['empty', () => new File([], 'empty.png', { type: 'image/png' }), /non-empty/],
    ['unsupported', () => new File(['svg'], 'image.svg', { type: 'image/svg+xml' }), /JPEG, PNG/],
    [
      'mismatched extension',
      () => new File(['text'], 'image.txt', { type: 'image/png' }),
      /matching file extension/,
    ],
    [
      'oversized',
      () => {
        const source = file();
        Object.defineProperty(source, 'size', { value: 5 * 1024 * 1024 + 1 });
        return source;
      },
      /no larger/,
    ],
    ['PDF', () => new File(['%PDF'], 'rx.pdf', { type: 'application/pdf' }), /JPEG, PNG/],
  ] as const)('rejects %s files before making a request', (_, source, message) => {
    render(<PrescriptionsConsole initialPatientId="patient/one" />);
    fillForm(source());
    submit();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText(/Prescription image/)).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it.each(['Permission denied', 'Storage unavailable'])(
    'preserves form after %s and retries the upload',
    async (message) => {
      mocks.upload.mockRejectedValueOnce(new Error(message));
      render(<PrescriptionsConsole initialPatientId="patient/one" />);
      const source = fillForm();
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent('Prescription not captured');
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Directions')).toHaveValue('One tablet daily');
      expect(screen.getByLabelText('Patient')).toHaveValue('patient/one');
      expect(screen.getByLabelText(/Prescription image/)).toBeEnabled();
      mocks.upload.mockResolvedValueOnce(response(source));
      expect(screen.getByRole('button', { name: 'Retry capture' })).toBeEnabled();
      // jsdom cannot populate a native file input value; dispatch the validated submit event.
      submit();
      await screen.findByRole('link', { name: /View saved attachment/ });
      expect(mocks.upload).toHaveBeenCalledTimes(2);
      expect(mocks.capture).toHaveBeenCalledTimes(1);
    }
  );

  it('retains a successful upload after capture failure and reuses it on retry', async () => {
    mocks.capture
      .mockRejectedValueOnce(new Error('Capture refused'))
      .mockResolvedValueOnce({ id: 'saved' });
    render(<PrescriptionsConsole initialPatientId="patient/one" />);
    const source = fillForm();
    mocks.upload.mockResolvedValue(response(source));
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'form and uploaded attachment are retained'
    );
    expect(screen.getByLabelText('Directions')).toHaveValue('One tablet daily');
    expect(screen.queryByRole('link', { name: /View saved attachment/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry capture' })).toBeEnabled();
    submit();
    await screen.findByRole('link', { name: /View saved attachment/ });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.capture.mock.calls[1][0].sourceFileRef).toBe(privateUrl);
  });

  it('keeps inputs locked and withholds saved status until capture persistence completes', async () => {
    let finishCapture!: () => void;
    mocks.capture.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCapture = resolve;
        })
    );
    render(<PrescriptionsConsole initialPatientId="patient/one" />);
    const source = fillForm();
    mocks.upload.mockResolvedValue(response(source));
    submit();
    await screen.findByRole('progressbar', { name: 'Saving prescription' });
    expect(screen.getByLabelText('Patient')).toBeDisabled();
    expect(screen.getByLabelText(/Prescription image/)).toBeDisabled();
    expect(screen.queryByRole('link', { name: /View saved attachment/ })).toBeNull();
    submit();
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    await act(async () => finishCapture());
    expect(await screen.findByRole('link', { name: /View saved attachment/ })).toBeVisible();
  });

  it('does not reuse a patient-bound upload after selecting another patient', async () => {
    mocks.capture
      .mockRejectedValueOnce(new Error('Capture refused'))
      .mockResolvedValueOnce({ id: 'saved' });
    render(<PrescriptionsConsole initialPatientId="patient/one" />);
    const source = fillForm();
    mocks.upload.mockResolvedValueOnce(response(source));
    submit();
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('Patient'), { target: { value: 'patient-two' } });
    const nextUrl = '/api/pharmacy/prescription-files?id=12345678-1234-4123-8123-123456789abd';
    mocks.upload.mockResolvedValueOnce(response(source, nextUrl));
    submit();
    await screen.findByRole('link', { name: /View saved attachment/ });
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.upload.mock.calls[1][0].patientId).toBe('patient-two');
    expect(mocks.capture.mock.calls[1][0]).toEqual(
      expect.objectContaining({ patientId: 'patient-two', sourceFileRef: nextUrl })
    );
  });

  it.each(['size', 'contentType', 'sourceFileRef'] as const)(
    'rejects mismatched upload receipt %s',
    async (field) => {
      render(<PrescriptionsConsole initialPatientId="patient/one" />);
      const source = fillForm();
      mocks.upload.mockResolvedValue({
        ...response(source),
        [field]: field === 'size' ? source.size + 1 : 'invalid',
      });
      submit();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'could not confirm the attachment'
      );
      expect(mocks.capture).not.toHaveBeenCalled();
    }
  );

  it.each([
    'capture://prescription.png',
    'https://example.test/private.png',
    '/api/files/../secret',
  ])('refuses an untrusted upload reference: %s', async (url) => {
    render(<PrescriptionsConsole initialPatientId="patient/one" />);
    const source = fillForm();
    mocks.upload.mockResolvedValue(response(source, url));
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not confirm the attachment');
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('treats refresh failure as saved capture, preventing an accidental duplicate retry', async () => {
    mocks.invalidate.mockRejectedValue(new Error('Refresh failed'));
    render(<PrescriptionsConsole initialPatientId="patient/one" />);
    const source = fillForm();
    mocks.upload.mockResolvedValue(response(source));
    submit();
    await waitFor(() => expect(screen.getByText(/Register refresh failed/)).toBeVisible());
    expect(screen.queryByRole('button', { name: 'Retry capture' })).toBeNull();
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it('shows stored attachment links and labels legacy references without treating them as uploads', () => {
    const prescription = (sourceFileRef: string) => ({
      sourceFileRef,
      patient: { displayName: 'First patient' },
      prescriber: { name: 'Prescriber' },
      validFrom: new Date('2026-01-01'),
      validUntil: new Date('2027-01-01'),
      custodyState: 'NOT_HELD',
      lines: [
        {
          id: sourceFileRef,
          medicine: { productName: 'Medicine' },
          presentation: { presentation: 'TABLET' },
          fills: [],
          remainingAuthorizedUnits: 12,
        },
      ],
    });
    mocks.workspace.mockReturnValue({
      data: {
        ...workspace(),
        prescriptions: [
          prescription(privateUrl),
          prescription('capture://old.png'),
          prescription('paper:123'),
        ],
      },
    });
    render(<PrescriptionsConsole />);
    expect(screen.getByRole('link', { name: /View attachment/ })).toHaveAttribute(
      'href',
      privateUrl
    );
    expect(screen.getAllByText('Reference only · no uploaded attachment')).toHaveLength(2);
  });

  it.each(['loading', 'denied'] as const)(
    'does not expose capture while workspace is %s',
    (state) => {
      mocks.workspace.mockReturnValue({
        data: undefined,
        isLoading: state === 'loading',
        error: state === 'denied' ? { message: 'Access denied' } : null,
      });
      render(<PrescriptionsConsole />);
      expect(screen.queryByRole('form', { name: 'Capture prescription' })).toBeNull();
      expect(screen.getByRole(state === 'loading' ? 'status' : 'alert')).toBeVisible();
    }
  );
});
