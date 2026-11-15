import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Branch = { id: string; name: string };

const h = vi.hoisted(() => ({
  branches: {
    isLoading: false,
    error: null,
    data: undefined as undefined | Branch[],
  },
  registerInputs: [] as Array<{ input: { branchId: string }; enabled: boolean }>,
  entries: [] as unknown[],
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySafety: {
      branches: { useQuery: () => h.branches },
      controlledRegister: {
        useQuery: (input: { branchId: string }, options: { enabled: boolean }) => {
          h.registerInputs.push({ input, enabled: options.enabled });
          return options.enabled
            ? { isLoading: false, error: null, data: { entries: h.entries }, refetch: vi.fn() }
            : { isLoading: false, error: null, data: undefined, refetch: vi.fn() };
        },
      },
      controlledPharmacists: { useQuery: () => ({ data: [] }) },
      recordCorrection: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

import { ControlledRegisterConsole } from './controlled-register-console';

const entry = {
  id: 'entry-1',
  serial: 1,
  createdAt: new Date('2026-11-01T06:00:00Z'),
  entryKind: 'SALE',
  emergency: false,
  balanceDelta: -2,
  runningBalance: 8,
  quantityCanonicalUnits: 2,
  batchNumber: 'B-100',
  inventoryLotId: 'lot-1',
  witnessName: 'Pharmacist Ayesha',
  signatureRef: 'sig',
  correctionReason: null,
  correctsEntryId: null,
  patientAddress: null,
  counterpartyName: null,
  prescriberName: null,
  prescriberRegNo: null,
  manufacturer: null,
  medicine: { productName: 'Register Tablet 5mg', manufacturer: 'Maker' },
  patient: { displayName: 'Patient One', cnic: '35202-*****-1' },
  prescriber: null,
  prescription: null,
  rxSerialWritten: false,
  line: null,
  correctsEntry: null,
  refEntry: null,
  incidents: [],
};

beforeEach(() => {
  h.branches = { isLoading: false, error: null, data: undefined };
  h.registerInputs = [];
  h.entries = [entry];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DEV-672 controlled register branch list', () => {
  it('shows a loading state, not a "No branch" picker, while branches load', () => {
    h.branches = { isLoading: true, error: null, data: undefined };

    render(<ControlledRegisterConsole />);

    expect(screen.getByRole('heading', { name: 'Loading branches' })).toBeInTheDocument();
    expect(screen.queryByText('No branch')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Branch/ })).not.toBeInTheDocument();
    expect(h.registerInputs.every((call) => !call.enabled)).toBe(true);
  });

  it('explains an unassigned user and points to branch assignments', () => {
    h.branches = { isLoading: false, error: null, data: [] };

    render(<ControlledRegisterConsole />);

    expect(
      screen.getByRole('heading', { name: 'No branch is assigned to you' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Branch assignments' })).toHaveAttribute(
      'href',
      '/pharmacy/settings/branches'
    );
    expect(screen.queryByText('No branch')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Branch/ })).not.toBeInTheDocument();
    expect(h.registerInputs.every((call) => !call.enabled)).toBe(true);
    expect(screen.getByRole('button', { name: 'Print register' })).toBeDisabled();
  });

  it('picks the only branch automatically and shows its register entries', () => {
    h.branches = { isLoading: false, error: null, data: [{ id: 'br-1', name: 'Gulberg' }] };

    render(<ControlledRegisterConsole />);

    expect(screen.queryByRole('combobox', { name: /Branch/ })).not.toBeInTheDocument();
    expect(screen.getByText('Gulberg')).toBeInTheDocument();
    expect(h.registerInputs.at(-1)).toEqual({ input: { branchId: 'br-1' }, enabled: true });
    const table = screen.getByRole('region', { name: 'Controlled medicine register' });
    expect(within(table).getByText('Register Tablet 5mg')).toBeInTheDocument();
    expect(within(table).getByText('Patient One')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print register' })).toBeEnabled();
  });

  it('offers a picker without a "No branch" option when there are several branches', () => {
    h.branches = {
      isLoading: false,
      error: null,
      data: [
        { id: 'br-1', name: 'Gulberg' },
        { id: 'br-2', name: 'Johar Town' },
      ],
    };

    render(<ControlledRegisterConsole />);

    const picker = screen.getByRole('combobox', { name: /Branch/ });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Gulberg', 'Johar Town']);
    expect(h.registerInputs.at(-1)?.input).toEqual({ branchId: 'br-1' });

    fireEvent.change(picker, { target: { value: 'br-2' } });

    expect(h.registerInputs.at(-1)).toEqual({ input: { branchId: 'br-2' }, enabled: true });
  });

  it('prints the register table with the branch name', () => {
    h.branches = { isLoading: false, error: null, data: [{ id: 'br-1', name: 'Gulberg' }] };
    const popup = document.implementation.createHTMLDocument('print');
    const print = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue({
      document: popup,
      opener: {},
      focus: vi.fn(),
      print,
    } as unknown as Window);

    render(<ControlledRegisterConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Print register' }));

    expect(open).toHaveBeenCalledOnce();
    expect(print).toHaveBeenCalledOnce();
    expect(popup.querySelector('h1')?.textContent).toBe('Controlled medicine register');
    expect(popup.body.textContent).toContain('Gulberg');
    expect(popup.querySelector('table')?.textContent).toContain('Register Tablet 5mg');
    expect(screen.queryByText(/Allow the print window/)).not.toBeInTheDocument();
  });
});
