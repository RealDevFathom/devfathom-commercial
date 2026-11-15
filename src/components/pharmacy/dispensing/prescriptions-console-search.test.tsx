import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workspace: { data: undefined as unknown, isLoading: false, error: null },
  mutation: { mutateAsync: vi.fn(), isPending: false, error: null },
  upload: { mutateAsync: vi.fn(), isPending: false, error: null },
  createPatient: { mutateAsync: vi.fn(), isPending: false, error: null },
  createPrescriber: { mutateAsync: vi.fn(), isPending: false, error: null },
  invalidate: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyPrescriptions: { workspace: { invalidate: mocks.invalidate } } }),
    pharmacyPrescriptions: {
      workspace: { useQuery: () => mocks.workspace },
      capture: { useMutation: () => mocks.mutation },
      uploadSource: { useMutation: () => mocks.upload },
      captureRefillReminder: { useMutation: () => mocks.mutation },
      createPatient: { useMutation: () => mocks.createPatient },
      createPrescriber: { useMutation: () => mocks.createPrescriber },
    },
  },
}));

import { PrescriptionsConsole } from './prescriptions-console';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mutation.isPending = false;
  mocks.workspace.data = {
    branches: [{ id: 'branch', name: 'Main branch' }],
    selectedBranchId: 'branch',
    canDispense: true,
    patients: [{ id: 'patient', displayName: 'Patient A' }],
    prescribers: [{ id: 'prescriber', name: 'Dr A', registrationNumber: '123' }],
    medicines: [
      {
        id: 'amoxicillin',
        productName: 'Amoxicillin 500mg',
        presentations: [{ id: 'capsule', presentation: 'Capsule' }],
      },
      {
        id: 'cetirizine', productName: 'Cetirizine 10mg',
        presentations: [{ id: 'tablet', presentation: 'Tablet' }],
      },
      { id: 'paracetamol', productName: 'Paracetamol 500mg', presentations: [] },
    ],
    reminderCaptures: [],
    prescriptions: [],
  };
});
afterEach(cleanup);

describe('capture medicine-name search', () => {
  it('keeps the medicine-form control mounted and resets its value when the medicine changes', () => {
    render(<PrescriptionsConsole />);
    const form = within(screen.getByRole('form', { name: 'Capture prescription' }));
    const medicine = form.getByRole('combobox', { name: 'Medicine' });
    const presentation = form.getByRole('combobox', { name: 'Medicine form' });

    fireEvent.change(medicine, { target: { value: 'amoxicillin' } });
    expect(form.getByRole('combobox', { name: 'Medicine form' })).toBe(presentation);
    fireEvent.change(presentation, { target: { value: 'capsule' } });
    expect(presentation).toHaveValue('capsule');

    fireEvent.change(medicine, { target: { value: 'cetirizine' } });
    expect(form.getByRole('combobox', { name: 'Medicine form' })).toBe(presentation);
    expect(presentation).toHaveValue('');
    fireEvent.change(presentation, { target: { value: 'tablet' } });
    expect(presentation).toHaveValue('tablet');
  });

  it('matches names without case or surrounding spaces, explains no matches, and clears', () => {
    render(<PrescriptionsConsole />);
    const form = within(screen.getByRole('form', { name: 'Capture prescription' }));
    const search = form.getByRole('searchbox', { name: 'Search medicine names' });
    const medicine = form.getByRole('combobox', { name: 'Medicine' });

    fireEvent.change(search, { target: { value: ' AMOX ' } });
    expect(within(medicine).getByRole('option', { name: 'Amoxicillin 500mg' })).toBeInTheDocument();
    expect(within(medicine).queryByRole('option', { name: 'Cetirizine 10mg' })).toBeNull();
    expect(within(medicine).queryByRole('option', { name: 'Paracetamol 500mg' })).toBeNull();
    expect(medicine).toHaveValue('');

    fireEvent.change(search, { target: { value: 'unlisted medicine' } });
    expect(form.getByRole('status')).toHaveTextContent('No medicines match this search');
    expect(search).toHaveAttribute('aria-describedby', 'capture-medicine-search-empty-0');
    expect(within(medicine).getAllByRole('option')).toHaveLength(1);
    expect(medicine).toHaveValue('');

    fireEvent.change(search, { target: { value: '' } });
    expect(within(medicine).getAllByRole('option')).toHaveLength(4);
    expect(form.queryByText(/No medicines match/)).toBeNull();
    expect(search).not.toHaveAttribute('aria-describedby');
    expect(mocks.mutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('keeps the selected medicine and line details when the name filter excludes it', () => {
    render(<PrescriptionsConsole />);
    const form = within(screen.getByRole('form', { name: 'Capture prescription' }));
    const search = form.getByRole('searchbox', { name: 'Search medicine names' });
    const medicine = form.getByRole('combobox', { name: 'Medicine' });
    const presentation = form.getByRole('combobox', { name: 'Medicine form' });
    const quantity = form.getByRole('spinbutton', { name: 'Prescribed quantity (units)' });
    const directions = form.getByRole('textbox', { name: 'Directions' });
    fireEvent.change(medicine, { target: { value: 'amoxicillin' } });
    fireEvent.change(presentation, { target: { value: 'capsule' } });
    fireEvent.change(quantity, { target: { value: '12' } });
    fireEvent.change(directions, { target: { value: 'One capsule every 8 hours' } });

    fireEvent.change(search, { target: { value: 'cetir' } });
    expect(medicine).toHaveValue('amoxicillin');
    expect(within(medicine).getByRole('option', { name: 'Amoxicillin 500mg' })).toBeInTheDocument();
    expect(within(medicine).getByRole('option', { name: 'Cetirizine 10mg' })).toBeInTheDocument();
    expect(within(medicine).queryByRole('option', { name: 'Paracetamol 500mg' })).toBeNull();
    expect(presentation).toHaveValue('capsule');
    expect(quantity).toHaveValue(12);
    expect(directions).toHaveValue('One capsule every 8 hours');

    fireEvent.change(search, { target: { value: 'unlisted medicine' } });
    expect(form.getByRole('status')).toHaveTextContent('No medicines match this search');
    expect(medicine).toHaveValue('amoxicillin');
    expect(presentation).toHaveValue('capsule');
    expect(quantity).toHaveValue(12);
    expect(directions).toHaveValue('One capsule every 8 hours');

    fireEvent.change(search, { target: { value: '' } });
    expect(within(medicine).getAllByRole('option', { name: 'Amoxicillin 500mg' })).toHaveLength(1);
    expect(medicine).toHaveValue('amoxicillin');
    expect(mocks.mutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('shows no no-match message for an empty catalog until a search is typed', () => {
    (mocks.workspace.data as { medicines: unknown[] }).medicines = [];
    render(<PrescriptionsConsole />);
    const form = within(screen.getByRole('form', { name: 'Capture prescription' }));
    const search = form.getByRole('searchbox', { name: 'Search medicine names' });

    expect(search).toHaveValue('');
    expect(form.queryByText(/No medicines match/)).toBeNull();
    expect(search).not.toHaveAttribute('aria-describedby');

    fireEvent.change(search, { target: { value: 'amox' } });
    expect(form.getByRole('status')).toHaveTextContent('No medicines match this search');
    expect(search).toHaveAttribute('aria-describedby', 'capture-medicine-search-empty-0');
  });
});

const attachment = '/api/pharmacy/prescription-files?id=00000000-0000-4000-8000-000000000001';

function captureForm() {
  return screen.getByRole('form', { name: 'Capture prescription' });
}

function fillLine(index: number, medicineId: string, formId: string, quantity: string, directions: string) {
  const line = within(screen.getByRole('group', { name: `Line ${index}` }));
  fireEvent.change(line.getByRole('combobox', { name: 'Medicine' }), { target: { value: medicineId } });
  fireEvent.change(line.getByRole('combobox', { name: 'Medicine form' }), { target: { value: formId } });
  fireEvent.change(line.getByRole('spinbutton', { name: 'Prescribed quantity (units)' }), {
    target: { value: quantity },
  });
  fireEvent.change(line.getByRole('textbox', { name: 'Directions' }), { target: { value: directions } });
}

function fillCapture() {
  const form = captureForm();
  const fields = within(form);
  fireEvent.change(fields.getByRole('combobox', { name: /^Patient$/ }), {
    target: { value: 'patient' },
  });
  fireEvent.change(fields.getByRole('combobox', { name: /^Prescriber$/ }), {
    target: { value: 'prescriber' },
  });
  fireEvent.change(fields.getByLabelText('Valid from'), { target: { value: '2026-11-10' } });
  fireEvent.change(fields.getByLabelText('Valid until'), { target: { value: '2026-12-10' } });
  const file = new File(['image'], 'prescription.png', { type: 'image/png' });
  mocks.upload.mutateAsync.mockResolvedValue({
    url: attachment, sourceFileRef: attachment, size: file.size, contentType: file.type,
  });
  fireEvent.change(fields.getByLabelText('Prescription image', { exact: false }), {
    target: { files: [file] },
  });
  fillLine(1, 'amoxicillin', 'capsule', '12', 'One capsule every 8 hours');
  return form;
}

describe('prescription capture prerequisites and copy', () => {
  it('explains the disabled action and updates the next step as prerequisites are supplied', () => {
    render(<PrescriptionsConsole />);
    const form = within(captureForm());
    const capture = form.getByRole('button', { name: 'Capture prescription' });
    expect(capture).toBeDisabled();
    expect(capture).toHaveAccessibleDescription(/Select a patient above/);
    expect(capture).toHaveAccessibleDescription(/Choose a prescription image above/);

    fireEvent.change(form.getByRole('combobox', { name: /^Patient$/ }), {
      target: { value: 'patient' },
    });
    expect(capture).toBeDisabled();
    expect(capture).not.toHaveAccessibleDescription(/Select a patient above/);
    expect(capture).toHaveAccessibleDescription(/Choose a prescription image above/);

    fireEvent.change(form.getByLabelText('Prescription image', { exact: false }), {
      target: { files: [new File(['invalid'], 'prescription.pdf', { type: 'application/pdf' })] },
    });
    expect(capture).toBeDisabled();
    expect(capture).toHaveAccessibleDescription(/Use a JPEG, PNG or WebP/);
    expect(form.getByRole('alert')).toHaveTextContent('Use a JPEG, PNG or WebP');

    fillCapture();
    expect(capture).toBeEnabled();
    expect(capture).toHaveAccessibleDescription(/Complete the patient, prescriber, dates/);
    expect(mocks.upload.mutateAsync).not.toHaveBeenCalled();
    expect(mocks.mutation.mutateAsync).not.toHaveBeenCalled();
  });

  it('gives a setup next step for empty patient, prescriber and medicine directories', () => {
    Object.assign(mocks.workspace.data as object, { patients: [], prescribers: [], medicines: [] });
    render(<PrescriptionsConsole />);
    const capture = within(captureForm()).getByRole('button', { name: 'Capture prescription' });
    expect(capture).toBeDisabled();
    expect(capture).toHaveAccessibleDescription(/Add the patient under Patients and prescribers/);
    expect(capture).toHaveAccessibleDescription(
      /Add the prescribing doctor under Patients and prescribers/
    );
    expect(capture).toHaveAccessibleDescription(/administrator to add a medicine with a medicine form/);
  });

  it('explains the disabled action while saving and prevents edits', () => {
    mocks.mutation.isPending = true;
    render(<PrescriptionsConsole initialPatientId="patient" />);
    const form = within(captureForm());
    const capture = form.getByRole('button', { name: 'Capturing…' });
    expect(capture).toBeDisabled();
    expect(capture).toHaveAccessibleDescription('Attachment uploaded. Saving prescription…');
    expect(form.getByRole('combobox', { name: /^Patient$/ })).toBeDisabled();
    expect(form.getByRole('button', { name: 'Add line' })).toBeDisabled();
  });

  it('explains an unavailable patient passed from the counter', () => {
    render(<PrescriptionsConsole initialPatientId="unavailable" />);
    const form = within(captureForm());
    expect(form.getByRole('alert')).toHaveTextContent('Select an accessible patient');
    expect(form.getByRole('button', { name: 'Capture prescription' })).toHaveAccessibleDescription(
      /Select a patient above/
    );
  });

  it('uses plain prescription copy without the internal RX-02 code', () => {
    render(<PrescriptionsConsole />);
    expect(screen.getByText('Save the prescription image and prescribed medicines before dispensing.')).toBeInTheDocument();
    expect(screen.getByLabelText('Where is the original prescription?')).toBeInTheDocument();
    expect(screen.getByLabelText('Prescription source')).toBeInTheDocument();
    expect(screen.queryByText(/RX-02|original evidence, authority|Original custody/)).toBeNull();
  });
});

describe('multiple prescription lines', () => {
  it('submits every line, keeps searches independent and resets after success', async () => {
    render(<PrescriptionsConsole />);
    const form = fillCapture();
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    fillLine(2, 'cetirizine', 'tablet', '10', 'One tablet daily');
    const secondLine = within(screen.getByRole('group', { name: 'Line 2' }));
    fireEvent.change(secondLine.getByRole('searchbox'), { target: { value: ' CEtir ' } });
    expect(within(secondLine.getByRole('combobox', { name: 'Medicine' })).queryByRole('option', {
      name: 'Amoxicillin 500mg',
    })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Line 1' })).getByRole('combobox', {
      name: 'Medicine',
    })).toHaveValue('amoxicillin');

    fireEvent.submit(form);
    await waitFor(() => expect(mocks.mutation.mutateAsync).toHaveBeenCalledOnce());
    expect(mocks.mutation.mutateAsync).toHaveBeenCalledWith({
      patientId: 'patient', prescriberId: 'prescriber', sourceKind: 'PAPER_IMAGE',
      sourceFileRef: attachment, custodyState: 'NOT_HELD', authorizedRepeats: 0,
      validFrom: new Date('2026-11-10'), validUntil: new Date('2026-12-10'),
      lines: [
        { lineNumber: 1, medicineId: 'amoxicillin', presentationId: 'capsule',
          authorizedCanonicalUnits: 12, directions: 'One capsule every 8 hours' },
        { lineNumber: 2, medicineId: 'cetirizine', presentationId: 'tablet',
          authorizedCanonicalUnits: 10, directions: 'One tablet daily' },
      ],
    });
    await waitFor(() => expect(within(form).getByRole('status')).toHaveTextContent('Prescription captured.'));
    expect(screen.queryByRole('group', { name: 'Line 2' })).toBeNull();
    expect(within(form).getByRole('searchbox')).toHaveValue('');
    expect(within(form).getByRole('combobox', { name: 'Medicine' })).toHaveValue('');
    expect(within(form).getByRole('spinbutton', { name: 'Prescribed quantity (units)' })).toHaveValue(null);
    expect(within(form).getByRole('button', { name: 'Capture prescription' })).toBeDisabled();
    expect(screen.getByRole('link', { name: /View saved attachment/ })).toHaveAttribute('href', attachment);
  });

  it('preserves remaining line details after removal and submits consecutive line numbers', async () => {
    render(<PrescriptionsConsole />);
    const form = fillCapture();
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    fillLine(2, 'cetirizine', 'tablet', '10', 'One tablet daily');
    fireEvent.click(within(form).getByRole('button', { name: 'Remove line 1' }));
    const remaining = within(screen.getByRole('group', { name: 'Line 1' }));
    expect(remaining.getByRole('combobox', { name: 'Medicine' })).toHaveValue('cetirizine');
    expect(remaining.getByRole('combobox', { name: 'Medicine form' })).toHaveValue('tablet');
    expect(remaining.getByRole('spinbutton', { name: 'Prescribed quantity (units)' })).toHaveValue(10);
    expect(remaining.getByRole('textbox', { name: 'Directions' })).toHaveValue('One tablet daily');
    expect(within(form).queryByRole('button', { name: /Remove line/ })).toBeNull();
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.mutation.mutateAsync).toHaveBeenCalledOnce());
    expect(mocks.mutation.mutateAsync.mock.calls[0][0].lines).toEqual([
      { lineNumber: 1, medicineId: 'cetirizine', presentationId: 'tablet',
        authorizedCanonicalUnits: 10, directions: 'One tablet daily' },
    ]);
  });

  it('requires all new line details and clears the form selection when its medicine changes', () => {
    render(<PrescriptionsConsole />);
    fireEvent.click(within(captureForm()).getByRole('button', { name: 'Add line' }));
    const line = within(screen.getByRole('group', { name: 'Line 2' }));
    expect(line.getByRole('combobox', { name: 'Medicine' })).toBeRequired();
    expect(line.getByRole('combobox', { name: 'Medicine form' })).toBeRequired();
    expect(line.getByRole('spinbutton', { name: 'Prescribed quantity (units)' })).toBeRequired();
    expect(line.getByRole('textbox', { name: 'Directions' })).toBeRequired();
    fillLine(2, 'amoxicillin', 'capsule', '12', 'One capsule every 8 hours');
    fireEvent.change(line.getByRole('combobox', { name: 'Medicine' }), { target: { value: 'cetirizine' } });
    expect(line.getByRole('combobox', { name: 'Medicine form' })).toHaveValue('');
    expect(line.getByRole('textbox', { name: 'Directions' })).toHaveValue('One capsule every 8 hours');
    fireEvent.change(line.getByRole('combobox', { name: 'Medicine' }), { target: { value: 'paracetamol' } });
    expect(line.getByText(/Choose another medicine or ask a workspace administrator/)).toBeInTheDocument();
  });

  it('explains the 30-line limit and allows adding again after removing a line', () => {
    render(<PrescriptionsConsole />);
    const form = within(captureForm());
    const add = form.getByRole('button', { name: 'Add line' });
    for (let index = 1; index < 30; index++) fireEvent.click(add);
    expect(form.getAllByRole('group', { name: /^Line \d+$/ })).toHaveLength(30);
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(/up to 30 lines. Remove a line/);
    fireEvent.click(form.getByRole('button', { name: 'Remove line 2' }));
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(form.getAllByRole('group', { name: /^Line \d+$/ })).toHaveLength(30);
  });

  it('retains all lines and reuses the attachment when a capture fails and is retried', async () => {
    mocks.mutation.mutateAsync.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce({});
    render(<PrescriptionsConsole />);
    const form = fillCapture();
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    fillLine(2, 'cetirizine', 'tablet', '10', 'One tablet daily');
    fireEvent.submit(form);
    await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent(/retained for retry/));
    expect(within(form).getByRole('button', { name: 'Retry capture' })).toBeEnabled();
    expect(within(screen.getByRole('group', { name: 'Line 2' })).getByRole('textbox', {
      name: 'Directions',
    })).toHaveValue('One tablet daily');
    const failedPayload = mocks.mutation.mutateAsync.mock.calls[0][0];
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.mutation.mutateAsync).toHaveBeenCalledTimes(2));
    expect(mocks.mutation.mutateAsync.mock.calls[1][0]).toEqual(failedPayload);
    expect(mocks.upload.mutateAsync).toHaveBeenCalledOnce();
    await waitFor(() => expect(within(form).getByRole('status')).toHaveTextContent('Prescription captured.'));
  });
});

describe('DEV-626 inline patient and prescriber registration', () => {
  type Workspace = {
    patients: { id: string; displayName: string }[];
    prescribers: { id: string; name: string; registrationNumber: string }[];
  };
  const data = () => mocks.workspace.data as Workspace;

  it('adds a patient from an empty directory and selects it for capture', async () => {
    data().patients = [];
    mocks.createPatient.mutateAsync.mockResolvedValue({ id: 'patient-new', displayName: 'Sana' });
    mocks.invalidate.mockImplementation(async () => {
      data().patients = [{ id: 'patient-new', displayName: 'Sana' }];
    });
    render(<PrescriptionsConsole />);
    const add = within(screen.getByRole('form', { name: 'Add patient' }));
    fireEvent.change(add.getByLabelText('Patient name'), { target: { value: ' Sana ' } });
    fireEvent.change(add.getByLabelText('Phone (optional)'), { target: { value: '0300' } });
    fireEvent.click(add.getByRole('button', { name: 'Add patient' }));

    await waitFor(() =>
      expect(within(captureForm()).getByRole('combobox', { name: /^Patient$/ })).toHaveValue(
        'patient-new'
      )
    );
    expect(mocks.createPatient.mutateAsync).toHaveBeenCalledWith({
      displayName: 'Sana',
      phone: '0300',
      cnic: '',
    });
    expect(add.getByRole('status')).toHaveTextContent('Sana added and selected for capture.');
    expect(add.getByLabelText('Patient name')).toHaveValue('');
  });

  it('adds a prescriber and selects it in the capture form', async () => {
    mocks.createPrescriber.mutateAsync.mockResolvedValue({ id: 'dr-new', name: 'Dr B' });
    mocks.invalidate.mockImplementation(async () => {
      data().prescribers.push({ id: 'dr-new', name: 'Dr B', registrationNumber: 'PMDC-9' });
    });
    render(<PrescriptionsConsole />);
    const add = within(screen.getByRole('form', { name: 'Add prescriber' }));
    fireEvent.change(add.getByLabelText('Doctor name'), { target: { value: 'Dr B' } });
    fireEvent.change(add.getByLabelText('Registration number', { exact: false }), {
      target: { value: 'PMDC-9' },
    });
    fireEvent.click(add.getByRole('button', { name: 'Add prescriber' }));

    await waitFor(() =>
      expect(within(captureForm()).getByRole('combobox', { name: 'Prescriber' })).toHaveValue(
        'dr-new'
      )
    );
    expect(mocks.createPrescriber.mutateAsync).toHaveBeenCalledWith({
      name: 'Dr B',
      registrationNumber: 'PMDC-9',
      phone: '',
      facility: '',
    });
  });

  it('keeps entries and flags the registration number when it is already registered', async () => {
    mocks.createPrescriber.mutateAsync.mockRejectedValue(
      Object.assign(
        new Error('A prescriber with this registration number is already in the directory.'),
        {
          data: { code: 'CONFLICT' },
        }
      )
    );
    render(<PrescriptionsConsole />);
    const add = within(screen.getByRole('form', { name: 'Add prescriber' }));
    const registration = add.getByLabelText('Registration number', { exact: false });
    fireEvent.change(add.getByLabelText('Doctor name'), { target: { value: 'Dr A' } });
    fireEvent.change(registration, { target: { value: '123' } });
    fireEvent.click(add.getByRole('button', { name: 'Add prescriber' }));

    await waitFor(() =>
      expect(add.getByRole('alert')).toHaveTextContent(/already in the directory/)
    );
    expect(registration).toHaveAttribute('aria-invalid', 'true');
    expect(registration).toHaveValue('123');
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
