import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Workspace = {
  branches: { id: string; name: string }[];
  selectedBranchId: string | null;
  canDispense: boolean;
  patients: { id: string; displayName: string; phone: string | null }[];
  prescribers: { id: string; name: string; registrationNumber: string }[];
  medicines: {
    id: string;
    productName: string;
    presentations: { id: string; presentation: string }[];
  }[];
  reminderCaptures: unknown[];
  prescriptions: unknown[];
};

const emptyWorkspace = (): Workspace => ({
  branches: [{ id: 'branch', name: 'Main branch' }],
  selectedBranchId: 'branch',
  canDispense: true,
  patients: [],
  prescribers: [],
  medicines: [
    {
      id: 'medicine-a',
      productName: 'Amoxicillin 500mg',
      presentations: [{ id: 'presentation-a', presentation: 'Capsule' }],
    },
  ],
  reminderCaptures: [],
  prescriptions: [],
});

const mocks = vi.hoisted(() => ({
  workspace: { data: undefined as unknown, isLoading: false, error: null as unknown },
  mutations: {} as Record<
    string,
    { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean; error: null }
  >,
  mutation: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyPrescriptions: { workspace: { invalidate: vi.fn() } } }),
    pharmacyPrescriptions: new Proxy(
      {},
      {
        get: (_target, name: string) =>
          name === 'workspace'
            ? { useQuery: () => mocks.workspace }
            : { useMutation: () => (mocks.mutations[name] ??= mocks.mutation()) },
      }
    ),
  },
}));

import { PrescriptionsConsole } from './prescriptions-console';

beforeEach(() => {
  mocks.mutations = {};
  mocks.workspace.data = emptyWorkspace();
});
afterEach(cleanup);

const captureButton = () => screen.getByRole('button', { name: /capture prescription/i });

describe('prescription capture readiness', () => {
  it('states the prerequisites and links to add a patient and a prescriber', () => {
    render(<PrescriptionsConsole />);
    expect(screen.getByText(/You need a patient and a prescriber/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add a patient' })).toHaveAttribute(
      'href',
      '#add-patient'
    );
    expect(screen.getByRole('link', { name: 'Add a prescriber' })).toHaveAttribute(
      'href',
      '#add-prescriber'
    );
    expect(document.getElementById('add-patient')).not.toBeNull();
    expect(document.getElementById('add-prescriber')).not.toBeNull();
  });

  it('marks required capture fields', () => {
    render(<PrescriptionsConsole />);
    const form = screen.getByRole('form', { name: 'Capture prescription' });
    for (const name of ['patientId', 'prescriberId', 'validUntil', 'source']) {
      expect(form.querySelector(`[name="${name}"]`)).toHaveAttribute('aria-required', 'true');
    }
  });

  it('explains why capture is disabled and lists the missing items', () => {
    render(<PrescriptionsConsole />);
    expect(captureButton()).toBeDisabled();
    expect(captureButton()).toHaveAttribute('aria-describedby', 'capture-blockers');
    const blockers = document.getElementById('capture-blockers')!;
    const items = within(blockers)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toEqual([
      'Add a patient, then select them',
      'Add a prescriber, then select them',
      'Attach the prescription image',
      'Enter the valid-until date',
      'Line 1: add medicine, presentation, authorized units and directions',
    ]);
  });

  it('drops a blocker once its item is provided', () => {
    mocks.workspace.data = {
      ...emptyWorkspace(),
      patients: [{ id: 'patient-a', displayName: 'Ayesha Khan', phone: null }],
      prescribers: [{ id: 'prescriber-a', name: 'Dr. Imran Malik', registrationNumber: 'PMC-1' }],
    };
    render(<PrescriptionsConsole />);
    const form = screen.getByRole('form', { name: 'Capture prescription' });
    fireEvent.change(form.querySelector('[name="prescriberId"]')!, {
      target: { value: 'prescriber-a' },
    });
    fireEvent.change(form.querySelector('[name="validUntil"]')!, {
      target: { value: '2099-01-01' },
    });
    const blockers = document.getElementById('capture-blockers')!;
    expect(blockers).toHaveTextContent('Select a patient');
    expect(blockers).not.toHaveTextContent('prescriber');
    expect(blockers).not.toHaveTextContent('valid-until');
    expect(screen.queryByRole('link', { name: 'Add a patient' })).toBeNull();
  });

  it('adds and removes prescription lines', () => {
    render(<PrescriptionsConsole />);
    expect(screen.getAllByRole('group', { name: /^Line \d/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(screen.getAllByRole('group', { name: /^Line \d/ })).toHaveLength(2);
    expect(document.getElementById('capture-blockers')).toHaveTextContent('Line 2: add medicine');
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(screen.getAllByRole('group', { name: /^Line \d/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Remove line/ })).toBeNull();
  });
});

describe('prescription register filters', () => {
  const prescription = (id: string, patient: string, validUntil: string) => ({
    id,
    patient: { displayName: patient },
    prescriber: { name: 'Dr. Imran Malik', registrationNumber: 'PMC-1' },
    validFrom: new Date('2020-01-01T00:00:00.000Z'),
    validUntil: new Date(`${validUntil}T00:00:00.000Z`),
    custodyState: 'NOT_HELD',
    sourceFileRef: 'reference-only',
    lines: [
      {
        id: `${id}-line`,
        remainingAuthorizedUnits: 4,
        directions: 'Once daily',
        medicine: { productName: 'Amoxicillin 500mg' },
        presentation: { presentation: 'Capsule' },
        fills: [],
      },
    ],
  });

  beforeEach(() => {
    mocks.workspace.data = {
      ...emptyWorkspace(),
      prescriptions: [
        prescription('rx-active', 'Ayesha Khan', '2099-01-01'),
        prescription('rx-expired', 'Bilal Ahmed', '2020-06-01'),
      ],
    };
  });

  it('filters by search text and status, and can clear the filters', () => {
    render(<PrescriptionsConsole />);
    const table = () => screen.getByRole('region', { name: 'Captured prescriptions' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bilal' } });
    expect(within(table()).queryByText('Ayesha Khan')).toBeNull();
    expect(within(table()).getByText('Bilal Ahmed')).toBeVisible();
    expect(screen.getByText('Showing 1 of 2 prescriptions')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'ACTIVE' },
    });
    expect(screen.getByText('No prescriptions match these filters')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(within(table()).getByText('Ayesha Khan')).toBeVisible();
    expect(within(table()).getByText('Bilal Ahmed')).toBeVisible();
  });
});
