import { createRef } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CounterAlert } from '@/lib/pharmacy/counter-alerts';
import type { CounterPatientPanel } from '@/lib/pharmacy/counter-prescriptions';

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  workspace: undefined as
    undefined | { timezone: string; prescribers: never[]; medicines: never[] },
}));

vi.mock('@/components/pharmacy/dispensing/prescriptions-console', () => ({
  attachmentUrl: (url: string) => url.startsWith('/api/pharmacy/prescription-files?'),
  fileError: vi.fn(),
  imageBase64: vi.fn(),
  isImageType: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    pharmacyPrescriptions: {
      workspace: { useQuery: () => ({ data: mocks.workspace, isLoading: false, error: null }) },
      uploadSource: { useMutation: () => ({ isPending: false }) },
      extractSource: { useMutation: () => ({ isPending: false }) },
      capture: { useMutation: () => ({ isPending: false }) },
    },
    pharmacySales: {
      acknowledgeDuplicateSalt: {
        useMutation: () => ({ mutate: mocks.acknowledge, isPending: false, error: null }),
      },
    },
  },
}));

import { ApprovalSecretKindContext } from './counter-approval-copy';
import {
  CounterControlledAuthorization,
  CounterRxPanel,
  type CounterRxPanelProps,
} from './counter-rx-panel';

const patient: CounterPatientPanel = {
  patientId: 'patient-1',
  displayName: 'Sana Tariq',
  phone: '******0147',
  cnic: '*********1234',
  dispensingConsent: true,
  prescriptions: [
    {
      prescriptionId: 'rx-photo-1',
      prescriberName: 'Dr. Imran Qureshi',
      sourceKind: 'PAPER_IMAGE',
      custodyState: 'HELD_AT_PHARMACY',
      validFrom: '2026-10-30',
      validUntil: '2026-11-29',
      inDate: true,
      authorizedRepeats: 0,
      lines: [
        {
          prescriptionLineId: 'rx-line-1',
          lineNumber: 1,
          medicineId: 'medicine-1',
          medicineName: 'Amoxicillin 625 mg',
          presentationId: 'presentation-1',
          presentation: 'Tablet',
          directions: 'As prescribed',
          authorizedCanonicalUnits: 6,
          filledCanonicalUnits: 2,
          remainingAuthorizedUnits: 4,
          verified: true,
          latestDecision: 'SIGN',
        },
      ],
    },
  ],
};

const alerts: CounterAlert[] = [
  {
    key: 'rx-required',
    severity: 'SAFETY_BLOCK',
    code: 'RX_REQUIRED',
    message: 'Hydroxyzine requires a prescription before it can be dispensed.',
    remedy: 'Attach a captured prescription and have a pharmacist verify it.',
    saleLineRef: 'line-1',
  },
  {
    key: 'duplicate',
    severity: 'CLINICAL_ADVICE',
    code: 'DUPLICATE_ACTIVE_INGREDIENT',
    message: 'Two medicines contain paracetamol.',
    remedy: 'Check the combined dose with the patient.',
    saleLineRef: null,
    acknowledgement: {
      kind: 'DUPLICATE_ACTIVE_INGREDIENT',
      ingredientKey: 'paracetamol',
      medicines: [
        { medicineId: 'panadol', displayName: 'Panadol', ref: 'line-2' },
        { medicineId: 'calpol', displayName: 'Calpol', ref: 'line-3' },
      ],
    },
  },
  {
    key: 'expiry',
    severity: 'COMMERCIAL',
    code: 'NEAR_EXPIRY',
    message: 'Cetirizine dispenses from a batch expiring in 59 days.',
    remedy: 'Tell the customer the expiry before completing the sale.',
    saleLineRef: 'line-4',
  },
];

function props(overrides: Partial<CounterRxPanelProps> = {}): CounterRxPanelProps {
  return {
    alerts: [],
    patient: null,
    candidates: [],
    query: '',
    state: 'idle',
    onQueryChange: vi.fn(),
    onSearch: vi.fn(),
    onSelectPatient: vi.fn(),
    onClearPatient: vi.fn(),
    canCapturePrescription: true,
    ...overrides,
  };
}

function authorization(
  overrides: Partial<NonNullable<CounterRxPanelProps['controlled']>> = {}
): NonNullable<CounterRxPanelProps['controlled']> {
  return {
    prescriptionLineId: '',
    staffProfileId: '',
    pin: '',
    pharmacists: [{ id: 'pharmacist-1', name: 'Dr. Ahmed' }],
    loading: false,
    error: false,
    patientAddress: '',
    rxSerialWritten: false,
    emergency: false,
    prescriberName: '',
    prescriberRegNo: '',
    refSerial: '',
    onChange: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace = undefined;
});

describe('CounterRxPanel checks', () => {
  it('shows the branch-safe fill history beside the remaining quantity', () => {
    const rx = patient.prescriptions[0]!;
    const line = rx.lines[0]!;
    const fills = [
      { label: 'Dispensed at Central', date: '2026-11-25', quantity: 1 },
      { label: 'Dispensed at another branch', date: '2026-11-26', quantity: 1 },
    ];
    render(
      <CounterRxPanel
        {...props({
          patient: { ...patient, prescriptions: [{ ...rx, lines: [{ ...line, fills }] }] },
        })}
      />
    );
    const history = screen.getByRole('list', { name: 'Fill history for Amoxicillin 625 mg' });
    expect(
      within(history)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      'Dispensed at Central · 2026-11-25 · 1 unit',
      'Dispensed at another branch · 2026-11-26 · 1 unit',
    ]);
    expect(screen.getByText('4 of 6 units left')).toBeVisible();
  });

  it('leads with safety blocks, keeps notices distinct, and only acknowledges advice', () => {
    render(
      <CounterRxPanel
        {...props({ alerts, acknowledgementScope: { branchId: 'branch-1', saleId: 'sale-1' } })}
      />
    );

    const safety = screen.getByRole('region', { name: 'Safety blocks' });
    expect(screen.getAllByRole('region')[0]).toBe(safety);
    expect(within(safety).getByRole('alert')).toHaveTextContent(alerts[0]!.message);
    expect(within(safety).getByText(alerts[0]!.remedy!)).toBeInTheDocument();
    expect(within(safety).queryByRole('button')).not.toBeInTheDocument();
    const notices = screen.getByRole('region', { name: 'Counselling and notices' });
    expect(within(notices).getByRole('list', { name: 'Clinical advice' })).toHaveTextContent(
      alerts[1]!.remedy!
    );
    expect(within(notices).getByRole('list', { name: 'Commercial notices' })).toHaveTextContent(
      alerts[2]!.remedy!
    );
    expect(within(notices).queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(mocks.acknowledge).toHaveBeenCalledWith(
      { branchId: 'branch-1', saleId: 'sale-1', ingredientKey: 'paracetamol' },
      expect.any(Object)
    );
  });

  it('does not offer unscoped acknowledgments or claim completed safety checks from no alerts', () => {
    const { rerender } = render(<CounterRxPanel {...props({ alerts })} />);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.getByText(alerts[1]!.remedy!)).toBeInTheDocument();

    rerender(<CounterRxPanel {...props()} />);
    expect(screen.queryByText(/no safety block/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Safety checks run before payment/)).toBeInTheDocument();
  });

  it('shows masked patient, prescription evidence, remaining units, consent and signed status', () => {
    const onCapturePrescription = vi.fn();
    const onClearPatient = vi.fn();
    render(<CounterRxPanel {...props({ patient, onCapturePrescription, onClearPatient })} />);

    expect(screen.getByText('Sana Tariq')).toBeInTheDocument();
    expect(screen.getByText('******0147 · *********1234')).toBeInTheDocument();
    expect(screen.getByText('Dispensing consent')).toBeInTheDocument();
    expect(screen.getByText('In date')).toBeInTheDocument();
    expect(screen.getByText(/held at pharmacy/)).toBeInTheDocument();
    expect(screen.getByText('4 of 6 units left')).toBeInTheDocument();
    expect(screen.getByText('Pharmacist signed')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Prescription photo from Dr. Imran/ })).toHaveAttribute(
      'src',
      '/api/pharmacy/prescription-files?id=photo-1'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Capture prescription' }));
    expect(onCapturePrescription).toHaveBeenCalledWith({ patientId: 'patient-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Detach patient' }));
    expect(onClearPatient).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Photograph prescription' }));
    expect(screen.getByRole('form', { name: 'Photograph prescription' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save prescription' })).toBeDisabled();
    expect(
      screen.getByText(/Capture does not replace pharmacist review or dispensing consent/)
    ).toBeInTheDocument();
  });

  it('retains unsigned, expired and missing-consent states without offering expired authorization', () => {
    const prescription = patient.prescriptions[0]!;
    render(
      <CounterRxPanel
        {...props({
          patient: {
            ...patient,
            dispensingConsent: false,
            prescriptions: [
              {
                ...prescription,
                inDate: false,
                lines: [{ ...prescription.lines[0]!, verified: false, latestDecision: 'HOLD' }],
              },
            ],
          },
          controlled: authorization(),
        })}
      />
    );
    expect(screen.getByText('No consent on file')).toBeInTheDocument();
    expect(screen.getByText('Outside validity')).toBeInTheDocument();
    expect(screen.getByText('Awaiting sign · hold')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Prescription line')).getAllByRole('option')).toHaveLength(
      1
    );
  });

  it.each(['loading', 'error'] as const)('guards capture while patient state is %s', (state) => {
    render(<CounterRxPanel {...props({ patient, state, onCapturePrescription: vi.fn() })} />);
    expect(screen.getByRole('button', { name: 'Capture prescription' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Photograph prescription' })).toBeDisabled();
  });

  it('keeps fallback capture scoped, then removes patient actions when permission is denied', () => {
    const { rerender } = render(<CounterRxPanel {...props({ patient })} />);
    expect(screen.getByRole('link', { name: /Capture prescription/ })).toHaveAttribute(
      'href',
      '/pharmacy/prescriptions#patientId=patient-1'
    );
    rerender(<CounterRxPanel {...props({ patient, state: 'denied' })} />);
    expect(screen.getByText(/a prescription-only line will stay blocked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /prescription/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Capture prescription/ })).not.toBeInTheDocument();
  });

  it('withholds capture and photo upload, with an explanation, without prescription access', () => {
    const { rerender } = render(
      <CounterRxPanel
        {...props({ patient, canCapturePrescription: false, onCapturePrescription: vi.fn() })}
      />
    );
    expect(screen.queryByRole('button', { name: /Capture prescription/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Photograph prescription/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Prescription capture needs a pharmacist or administrator/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Detach patient' })).toBeEnabled();

    rerender(<CounterRxPanel {...props({ patient, canCapturePrescription: false })} />);
    expect(screen.queryByRole('link', { name: /Capture prescription/ })).not.toBeInTheDocument();
  });

  it('preserves keyboard focus, patient search, Enter and patient selection callbacks', () => {
    const ref = createRef<HTMLDivElement>();
    const callbacks = props({
      query: 'Sana',
      candidates: [
        { patientId: patient.patientId, displayName: patient.displayName, phone: patient.phone },
      ],
    });
    render(<CounterRxPanel {...callbacks} ref={ref} />);
    ref.current?.focus();
    expect(ref.current).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Find patient'), { target: { value: 'Sana Tariq' } });
    expect(callbacks.onQueryChange).toHaveBeenCalledWith('Sana Tariq');
    fireEvent.keyDown(screen.getByLabelText('Find patient'), { key: 'Enter' });
    expect(callbacks.onSearch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Sana Tariq/ }));
    expect(callbacks.onSelectPatient).toHaveBeenCalledWith('patient-1');
  });

  it('points an unmatched patient search at the add patient and prescriber forms (DEV-626)', () => {
    render(<CounterRxPanel {...props({ query: 'Nobody', state: 'ready' })} />);
    const link = screen.getByRole('link', {
      name: /Add the patient or prescriber in Prescriptions/,
    });
    expect(link).toHaveAttribute('href', '/pharmacy/prescriptions#prescription-directory');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('DEV-961: words the pharmacist step for the approval setting', () => {
    const controlled = { ...authorization(), staffProfileId: 'pharmacist-1' };
    // On (the default): the pharmacist's current app code.
    const { unmount } = render(<CounterRxPanel {...props({ patient, controlled })} />);
    expect(screen.getByLabelText('Pharmacist’s approval code')).toHaveAccessibleDescription(
      /6-digit code from their authenticator app/
    );
    expect(
      screen.getByText(/Patient address and the pharmacist’s approval code are required/)
    ).toBeInTheDocument();
    expect(screen.getByText(/The code is cleared after each attempt/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Pharmacist PIN')).toBeNull();
    unmount();
    // Off: the pharmacist's permanent PIN.
    render(
      <ApprovalSecretKindContext.Provider value="PIN">
        <CounterRxPanel {...props({ patient, controlled })} />
      </ApprovalSecretKindContext.Provider>
    );
    expect(screen.getByLabelText('Pharmacist PIN')).toHaveAccessibleDescription(/permanent PIN/);
    expect(
      screen.getByText(/Patient address and a pharmacist PIN are required/)
    ).toBeInTheDocument();
    expect(screen.getByText(/PIN is cleared after each attempt/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Pharmacist’s approval code')).toBeNull();
  });

  it('preserves pharmacist witness requirements and emergency authorization callbacks', () => {
    const controlled = authorization();
    const { rerender } = render(<CounterRxPanel {...props({ controlled })} />);
    expect(screen.getByLabelText('Patient address')).toBeDisabled();
    expect(screen.getByLabelText('Prescription line')).toBeDisabled();
    expect(screen.getByLabelText('Pharmacist’s approval code')).toBeDisabled();

    rerender(
      <CounterRxPanel
        {...props({
          patient,
          controlled: { ...controlled, emergency: true, staffProfileId: 'pharmacist-1' },
        })}
      />
    );
    const pin = screen.getByLabelText('Pharmacist’s approval code');
    expect(pin).toHaveAttribute('type', 'password');
    expect(pin).toHaveAttribute('autocomplete', 'off');
    // DEV-961: on by default, the pharmacist enters the current code from their app.
    expect(pin).toHaveAccessibleDescription(/6-digit code from their authenticator app/);
    for (const [label, field, value] of [
      ['Patient address', 'patientAddress', 'Model Town'],
      ['Prescription line', 'prescriptionLineId', 'rx-line-1'],
      ['Approving pharmacist', 'staffProfileId', 'pharmacist-1'],
      ['Pharmacist’s approval code', 'pin', '123456'],
      ['Prescriber name', 'prescriberName', 'Dr. Ahmed'],
      ['Prescriber registration', 'prescriberRegNo', 'REG-123'],
      ['Earlier register serial', 'refSerial', '42'],
    ]) {
      fireEvent.change(screen.getByLabelText(label!), { target: { value } });
      expect(controlled.onChange).toHaveBeenCalledWith(field, value);
    }
    fireEvent.click(screen.getByLabelText('Emergency supply, no prescription'));
    expect(controlled.onChange).toHaveBeenCalledWith('emergency', false);
    fireEvent.click(screen.getByLabelText('Register serial written on the prescription'));
    expect(controlled.onChange).toHaveBeenCalledWith('rxSerialWritten', true);

    rerender(
      <CounterRxPanel
        {...props({
          patient,
          controlled,
          disabled: true,
          alerts,
          acknowledgementScope: { branchId: 'branch-1', saleId: 'sale-1' },
        })}
      />
    );
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Detach patient' })).toBeDisabled();
    expect(screen.getByLabelText('Approving pharmacist')).toBeDisabled();
    expect(screen.getByLabelText('Emergency supply, no prescription')).toBeDisabled();
  });
});

describe('DEV-943: Rx photo dates use the shop’s day', () => {
  it.each([
    // 19:30 UTC on 18 Nov is already 00:30 on 19 Nov in Karachi.
    ['Asia/Karachi', '2026-11-18T19:30:00.000Z', '2026-11-20', '2026-12-19'],
    // 18:59 UTC is still 23:59 on 18 Nov in Karachi.
    ['Asia/Karachi', '2026-11-18T18:59:00.000Z', '2026-11-19', '2026-12-18'],
    // A UTC organisation keeps the UTC day, exactly as before.
    ['UTC', '2026-11-18T19:30:00.000Z', '2026-11-19', '2026-12-18'],
  ])('in %s at %s the valid-until field starts at %s and defaults to %s', (zone, now, min, day) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
    try {
      mocks.workspace = { timezone: zone, prescribers: [], medicines: [] };
      render(<CounterRxPanel {...props({ patient })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Photograph prescription' }));
      const validUntil = screen.getByLabelText('Valid until');
      expect(validUntil).toHaveAttribute('min', min);
      expect(validUntil).toHaveValue(day);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DEV-977 phase 2B: controlled medicine authorisation in the Counter v2 steps (A5)', () => {
  it('groups the fields into patient, prescription and approving pharmacist, in that order', () => {
    render(<CounterRxPanel {...props({ patient, controlled: authorization() })} />);
    const section = screen.getByRole('region', { name: 'Controlled medicine authorization' });
    expect(within(section).getByText('Controlled medicine · online only')).toBeInTheDocument();
    const patientStep = within(section).getByRole('region', { name: '1 · Patient' });
    const rxStep = within(section).getByRole('region', { name: '2 · Prescription' });
    const pharmacistStep = within(section).getByRole('region', {
      name: '3 · Approving pharmacist',
    });
    expect(within(patientStep).getByLabelText('Patient address')).toBeInTheDocument();
    expect(within(rxStep).getByLabelText('Prescription line')).toBeInTheDocument();
    expect(within(rxStep).getByLabelText('Emergency supply, no prescription')).toBeInTheDocument();
    expect(
      within(rxStep).getByLabelText('Register serial written on the prescription')
    ).toBeInTheDocument();
    expect(within(rxStep).getByLabelText('Earlier register serial')).toBeInTheDocument();
    expect(within(pharmacistStep).getByLabelText('Approving pharmacist')).toBeInTheDocument();
    expect(
      within(pharmacistStep).getByLabelText('Pharmacist’s approval code')
    ).toHaveAccessibleDescription(/./);
    // Document order follows the steps, so Tab walks them in turn.
    expect(
      patientStep.compareDocumentPosition(rxStep) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      rxStep.compareDocumentPosition(pharmacistStep) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('marks each step done only from what is filled in', () => {
    const { rerender } = render(
      <CounterRxPanel {...props({ patient, controlled: authorization() })} />
    );
    const states = () =>
      within(screen.getByRole('list', { name: 'Authorization steps' }))
        .getAllByRole('listitem')
        .map((step) => `${step.textContent}:${step.getAttribute('data-state')}`);
    expect(states()).toEqual([
      'Patient, to do:now',
      'Prescription, to do:todo',
      'Pharmacist, to do:todo',
    ]);
    rerender(
      <CounterRxPanel
        {...props({
          patient,
          controlled: authorization({ patientAddress: '12 Mall Road', emergency: true }),
        })}
      />
    );
    expect(states()).toEqual([
      'Patient, done:done',
      'Prescription, done:done',
      'Pharmacist, to do:now',
    ]);
    rerender(
      <CounterRxPanel
        {...props({
          patient,
          controlled: authorization({
            patientAddress: '12 Mall Road',
            prescriptionLineId: 'line-1',
            staffProfileId: 'pharmacist-1',
            pin: '1234',
          }),
        })}
      />
    );
    expect(states()).toEqual([
      'Patient, done:done',
      'Prescription, done:done',
      'Pharmacist, done:done',
    ]);
  });
});

describe('DEV-977 phase 3: the authorization inside the "Authorise" sheet', () => {
  it.each([
    ['CODE', 'Pharmacist’s approval code', /approval code are required/],
    ['PIN', 'Pharmacist PIN', /a pharmacist PIN are required/],
  ] as const)(
    'drops the heading the sheet already shows, keeping the region, steps and fields (%s)',
    (mode, label, intro) => {
      render(
        <ApprovalSecretKindContext.Provider value={mode}>
          <CounterControlledAuthorization
            inSheet
            patient={null}
            controlled={{
              prescriptionLineId: '',
              staffProfileId: '',
              pin: '',
              pharmacists: [],
              loading: false,
              error: false,
              patientAddress: '',
              rxSerialWritten: false,
              emergency: false,
              prescriberName: '',
              prescriberRegNo: '',
              refSerial: '',
              onChange: () => {},
            }}
          />
        </ApprovalSecretKindContext.Provider>
      );
      const region = screen.getByRole('region', { name: 'Controlled medicine authorization' });
      expect(
        within(region).queryByRole('heading', { name: 'Controlled medicine authorization' })
      ).toBeNull();
      expect(within(region).queryByText('Controlled medicine · online only')).toBeNull();
      // The approvals setting still decides the wording inside the sheet.
      expect(region).toHaveTextContent(intro);
      expect(within(region).getByRole('list', { name: 'Authorization steps' })).toBeInTheDocument();
      expect(within(region).getByLabelText('Patient address')).toBeDisabled();
      expect(within(region).getByLabelText(label)).toBeInTheDocument();
    }
  );
});
