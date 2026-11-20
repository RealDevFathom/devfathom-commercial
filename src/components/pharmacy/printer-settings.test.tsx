import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';

const mocks = vi.hoisted(() => ({
  branches: undefined as unknown,
  format: undefined as unknown,
  mutate: vi.fn(),
  invalidate: vi.fn(),
  options: {} as { onSuccess?: () => unknown; onError?: (error: unknown) => void },
  print: vi.fn(),
  isPending: false,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacySales: { counterReceiptFormat: { invalidate: mocks.invalidate } } }),
    pharmacySales: {
      counterBranches: { useQuery: () => mocks.branches },
      counterReceiptFormat: { useQuery: () => mocks.format },
      counterSaveReceiptFormat: {
        useMutation: (options: typeof mocks.options) => {
          mocks.options = options;
          return { mutate: mocks.mutate, isPending: mocks.isPending };
        },
      },
    },
  },
}));

vi.mock('@/lib/pharmacy/counter-browser-print', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/counter-browser-print')>()),
  printPrinterTestPage: mocks.print,
}));

const bridges = vi.hoisted(() => ({ props: vi.fn() }));
vi.mock('./print-bridges', () => ({
  PharmacyPrintBridges: (props: { branchName: string }) => {
    bridges.props(props);
    return <p>Print bridges for {props.branchName}</p>;
  },
}));

import { layoutWithPaper, PharmacyPrinterSettingsConsole } from './printer-settings';

const ok = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
const layout = { ...DEFAULT_RECEIPT_LAYOUT, footerText: 'Get well soon' };

beforeEach(() => {
  mocks.branches = ok({
    branches: [
      { id: 'b1', name: 'Main', code: 'M1' },
      { id: 'b2', name: 'Second', code: 'S2' },
    ],
  });
  mocks.format = ok({ layout, revision: 4 });
  mocks.mutate.mockReset();
  mocks.print.mockReset();
  mocks.invalidate.mockReset();
  mocks.isPending = false;
});

describe('layoutWithPaper', () => {
  it('changes only the paper fields and keeps every other saved setting', () => {
    expect(layoutWithPaper(layout, 'A4')).toEqual({ ...layout, browserPaper: 'A4' });
    const thermal = layoutWithPaper({ ...layout, browserPaper: 'A4' }, 'THERMAL_58');
    expect(thermal).toEqual({ ...layout, paperWidth: 58 });
    expect('browserPaper' in thermal).toBe(false);
  });
});

describe('PharmacyPrinterSettingsConsole', () => {
  it('shows the saved branch paper and saves a new choice with the current revision', () => {
    render(<PharmacyPrinterSettingsConsole canSave />);
    const paper = screen.getByLabelText('Receipt printer and paper');
    expect(paper).toHaveValue('THERMAL');
    expect(screen.getByRole('button', { name: 'Save printer settings' })).toBeDisabled();
    fireEvent.change(paper, { target: { value: 'A4' } });
    expect(screen.getByText('Unsaved change')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save printer settings' }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      branchId: 'b1',
      revision: 4,
      layout: { ...layout, browserPaper: 'A4' },
    });
  });

  it('starts on a saved A4 preference and a saved 58 mm roll', () => {
    mocks.format = ok({ layout: { ...layout, browserPaper: 'A4' }, revision: 1 });
    const { unmount } = render(<PharmacyPrinterSettingsConsole canSave />);
    expect(screen.getByLabelText('Receipt printer and paper')).toHaveValue('A4');
    unmount();
    mocks.format = ok({ layout: { ...layout, paperWidth: 58 }, revision: 1 });
    render(<PharmacyPrinterSettingsConsole canSave />);
    expect(screen.getByLabelText('Receipt printer and paper')).toHaveValue('THERMAL_58');
  });

  it('reports a saved result and refreshes the branch format', async () => {
    render(<PharmacyPrinterSettingsConsole canSave />);
    await mocks.options.onSuccess?.();
    expect(await screen.findByRole('status')).toHaveTextContent('Saved for Main.');
    expect(mocks.invalidate).toHaveBeenCalledWith({ branchId: 'b1' });
  });

  it('explains a concurrent change and a refused save honestly', async () => {
    render(<PharmacyPrinterSettingsConsole canSave />);
    mocks.options.onError?.({ data: { code: 'CONFLICT' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed elsewhere/);
    mocks.options.onError?.({ data: { code: 'FORBIDDEN' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Only a workspace administrator/);
  });

  it('keeps the paper read-only for non-administrators but allows a test print', () => {
    render(<PharmacyPrinterSettingsConsole canSave={false} />);
    expect(screen.getByLabelText('Receipt printer and paper')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save printer settings' })).toBeDisabled();
    expect(screen.getByText(/Only a workspace administrator can change/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Print test page' }));
    expect(mocks.print).toHaveBeenCalledWith('THERMAL', 'en', 'Main');
  });

  it('prints an Urdu test page on the selected paper without claiming the printer printed', async () => {
    render(<PharmacyPrinterSettingsConsole canSave />);
    fireEvent.change(screen.getByLabelText('Receipt printer and paper'), {
      target: { value: 'THERMAL_58' },
    });
    fireEvent.change(screen.getByLabelText('Test language'), { target: { value: 'ur' } });
    fireEvent.click(screen.getByRole('button', { name: 'Print test page' }));
    expect(mocks.print).toHaveBeenCalledWith('THERMAL_58', 'ur', 'Main');
    expect(await screen.findByRole('status')).toHaveTextContent(
      /cannot see whether the page printed or the dialog was cancelled/
    );
  });

  it('shows a failed test print and lets the operator retry', async () => {
    // DEV-973: a blocked print window is reported once its page fails to load.
    mocks.print.mockRejectedValueOnce(
      new Error('Allow pop-ups for this site, then retry Print test page.')
    );
    render(<PharmacyPrinterSettingsConsole canSave />);
    fireEvent.click(screen.getByRole('button', { name: 'Print test page' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Allow pop-ups');
    fireEvent.click(screen.getByRole('button', { name: 'Print test page' }));
    expect(mocks.print).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('status')).toHaveTextContent(/Print dialog opened/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('switches branch and offers retry when saved settings cannot be read', () => {
    render(<PharmacyPrinterSettingsConsole canSave />);
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'b2' } });
    expect(screen.getByLabelText('Branch')).toHaveValue('b2');
    const refetch = vi.fn();
    mocks.format = { data: undefined, isLoading: false, isError: true, refetch };
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'b1' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded. Nothing was changed/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('explains when there is no active branch', () => {
    mocks.branches = ok({ branches: [] });
    render(<PharmacyPrinterSettingsConsole canSave />);
    expect(screen.getByText(/No active pharmacy branch/)).toBeInTheDocument();
  });

  it('shows the print bridge section to administrators for the selected branch only', () => {
    bridges.props.mockClear();
    const { unmount } = render(<PharmacyPrinterSettingsConsole canSave />);
    expect(screen.getByRole('heading', { name: 'Thermal print bridges' })).toBeInTheDocument();
    expect(bridges.props).toHaveBeenLastCalledWith({ branchId: 'b1', branchName: 'Main' });
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'b2' } });
    expect(bridges.props).toHaveBeenLastCalledWith({ branchId: 'b2', branchName: 'Second' });
    unmount();
    bridges.props.mockClear();
    render(<PharmacyPrinterSettingsConsole canSave={false} />);
    expect(screen.queryByRole('heading', { name: 'Thermal print bridges' })).toBeNull();
    expect(bridges.props).not.toHaveBeenCalled();
  });

  it('offers no restaurant kitchen routing', () => {
    render(<PharmacyPrinterSettingsConsole canSave />);
    expect(screen.queryByText(/kitchen|station|routing/i)).not.toBeInTheDocument();
  });
});
