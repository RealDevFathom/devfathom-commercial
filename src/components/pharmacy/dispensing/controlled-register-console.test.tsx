import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  branches: {
    data: undefined as { id: string; name: string }[] | undefined,
    isSuccess: false,
    isPending: true,
    isFetching: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  register: {
    data: undefined as { entries: unknown[] } | undefined,
    isLoading: false,
    isFetching: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  registerQuery: vi.fn(),
  correct: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySafety: {
      branches: { useQuery: () => mocks.branches },
      controlledRegister: {
        useQuery: (input: unknown, options: unknown) => {
          mocks.registerQuery(input, options);
          return mocks.register;
        },
      },
      controlledPharmacists: { useQuery: () => ({ data: [] }) },
      recordCorrection: { useMutation: () => ({ mutate: mocks.correct, isPending: false }) },
    },
  },
}));

import { ControlledRegisterConsole } from './controlled-register-console';

const branch = { id: 'branch-a', name: 'SehatCart Test Branch' };
const entry = {
  id: 'entry-1',
  serial: 1,
  createdAt: new Date('2026-11-02T12:00:00Z'),
  entryKind: 'PURCHASE',
  quantityCanonicalUnits: 10,
  balanceDelta: 10,
  runningBalance: 10,
  inventoryLotId: 'lot-1',
  batchNumber: 'BATCH-1',
  medicine: { productName: 'Fixture medicine', manufacturer: 'Fixture manufacturer' },
  counterpartyName: 'Fixture supplier',
  witnessName: 'Qualified person',
  incidents: [],
};

function accessible(branches = [branch]) {
  Object.assign(mocks.branches, { data: branches, isSuccess: true, isPending: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.branches, {
    data: undefined,
    isSuccess: false,
    isPending: true,
    isFetching: false,
    error: null,
  });
  Object.assign(mocks.register, {
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ControlledRegisterConsole', () => {
  it('distinguishes branch loading from no access and does not read an empty branch', () => {
    render(<ControlledRegisterConsole />);
    expect(screen.getByRole('heading', { name: 'Loading branches' })).toBeVisible();
    expect(screen.getByLabelText('Branch')).toBeDisabled();
    expect(screen.queryByText('No accessible branches')).toBeNull();
    expect(mocks.registerQuery).toHaveBeenLastCalledWith({ branchId: '' }, { enabled: false });
    expect(screen.getByRole('button', { name: 'Print register' })).toBeDisabled();
  });

  it('automatically selects the sole accessible branch when loading finishes', () => {
    const view = render(<ControlledRegisterConsole />);
    accessible();
    mocks.register.data = { entries: [] };
    view.rerender(<ControlledRegisterConsole />);
    expect(screen.getByLabelText('Branch')).toHaveValue(branch.id);
    expect(mocks.registerQuery).toHaveBeenLastCalledWith(
      { branchId: branch.id },
      { enabled: true }
    );
    expect(screen.getByText('No register entries for this branch yet.')).toBeVisible();
    expect(screen.queryByLabelText('Entry to correct')).toBeNull();
    expect(screen.getByRole('button', { name: 'Print register' })).toBeDisabled();
  });

  it('requires an explicit choice for multiple branches and respects a later choice', () => {
    accessible([branch, { id: 'branch-b', name: 'Second branch' }]);
    render(<ControlledRegisterConsole />);
    expect(screen.getByLabelText('Branch')).toHaveValue('');
    expect(mocks.registerQuery).toHaveBeenLastCalledWith({ branchId: '' }, { enabled: false });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    expect(mocks.registerQuery).toHaveBeenLastCalledWith(
      { branchId: 'branch-b' },
      { enabled: true }
    );
  });

  it('explains an empty assignment set without inventing branch access', () => {
    accessible([]);
    render(<ControlledRegisterConsole />);
    expect(screen.getByRole('heading', { name: 'No accessible branches' })).toBeVisible();
    expect(screen.getByText(/Ask your administrator to assign you/)).toBeVisible();
    expect(screen.queryByText('No register entries for this branch yet.')).toBeNull();
    expect(mocks.registerQuery).toHaveBeenLastCalledWith({ branchId: '' }, { enabled: false });
  });

  it('shows a branch load failure and retries without displaying cached entries', () => {
    accessible();
    Object.assign(mocks.branches, { isSuccess: false, error: new Error('Access denied') });
    mocks.register.data = { entries: [entry] };
    render(<ControlledRegisterConsole />);
    expect(screen.getByRole('alert')).toHaveTextContent('Access denied');
    expect(screen.queryByText('Fixture medicine')).toBeNull();
    expect(screen.getByRole('button', { name: 'Print register' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry branches' }));
    expect(mocks.branches.refetch).toHaveBeenCalledOnce();
  });

  it('stops reading and hides entries when the selected branch is no longer accessible', () => {
    accessible();
    mocks.register.data = { entries: [entry] };
    const view = render(<ControlledRegisterConsole />);
    accessible([]);
    view.rerender(<ControlledRegisterConsole />);
    expect(screen.queryByText('Fixture medicine')).toBeNull();
    expect(screen.getByRole('button', { name: 'Print register' })).toBeDisabled();
    expect(mocks.registerQuery).toHaveBeenLastCalledWith({ branchId: '' }, { enabled: false });
  });

  it('distinguishes register loading and failed reads from a successful empty register', () => {
    accessible();
    mocks.register.isLoading = true;
    const view = render(<ControlledRegisterConsole />);
    expect(screen.getByRole('heading', { name: 'Loading controlled register' })).toBeVisible();
    Object.assign(mocks.register, {
      isLoading: false,
      data: { entries: [entry] },
      error: new Error('Register unavailable'),
    });
    view.rerender(<ControlledRegisterConsole />);
    expect(screen.getByRole('alert')).toHaveTextContent('Register unavailable');
    expect(screen.queryByText('Fixture medicine')).toBeNull();
    expect(screen.getByRole('button', { name: 'Print register' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry register' }));
    expect(mocks.register.refetch).toHaveBeenCalledOnce();
  });

  it('renders register fields and prints only the register with branch identity and totals', () => {
    accessible();
    mocks.register.data = { entries: [entry] };
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const printDocument = frame.contentDocument!;
    const popup = { document: printDocument, opener: window, focus: vi.fn(), print: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<ControlledRegisterConsole />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Fixture medicine')).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'Qualified person' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Print register' }));
    expect(popup.print).toHaveBeenCalledOnce();
    expect(popup.opener).toBeNull();
    expect(printDocument.body.textContent).toContain(branch.name);
    expect(printDocument.body.textContent).toContain('Fixture medicine');
    expect(printDocument.body.textContent).toContain('1 rows · in 10 · out 0');
    expect(printDocument.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(printDocument.querySelector('form')).toBeNull();
    expect(
      frame.contentWindow!.getComputedStyle(printDocument.querySelector('td > span')!).display
    ).toBe('block');
    frame.remove();
  });

  it('reports a blocked print popup and allows a retry', () => {
    accessible();
    mocks.register.data = { entries: [entry] };
    const print = vi.fn();
    vi.spyOn(window, 'open')
      .mockReturnValueOnce(null)
      .mockReturnValue({
        document: document.implementation.createHTMLDocument(),
        focus: vi.fn(),
        print,
      } as unknown as Window);
    render(<ControlledRegisterConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Print register' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Allow the print window');
    fireEvent.click(screen.getByRole('button', { name: 'Print register' }));
    expect(print).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables print while the register refreshes and clears correction identity/PIN on branch change', () => {
    accessible([branch, { id: 'branch-b', name: 'Second branch' }]);
    mocks.register.data = { entries: [entry] };
    mocks.register.isFetching = true;
    render(<ControlledRegisterConsole />);
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: branch.id } });
    expect(screen.getByRole('button', { name: 'Print register' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Entry to correct'), { target: { value: entry.id } });
    fireEvent.change(screen.getByLabelText('Pharmacist PIN'), { target: { value: '1234' } });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    expect(screen.getByLabelText('Entry to correct')).toHaveValue('');
    expect(screen.getByLabelText('Pharmacist PIN')).toHaveValue('');
    expect(mocks.correct).not.toHaveBeenCalled();
  });
});
