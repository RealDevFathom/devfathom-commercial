import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';

type Query = {
  data?: unknown;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  branches: undefined as unknown as Query,
  format: undefined as unknown as Query,
  formatInputs: [] as unknown[],
  mutateAsync: vi.fn(),
  isPending: false,
  setData: vi.fn(),
  cancel: vi.fn(async () => undefined),
  openPage: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacySales: { counterReceiptFormat: { setData: mocks.setData, cancel: mocks.cancel } },
    }),
    pharmacySales: {
      counterBranches: { useQuery: () => mocks.branches },
      counterReceiptFormat: {
        useQuery: (input: unknown) => {
          mocks.formatInputs.push(input);
          return mocks.format;
        },
      },
      counterSaveReceiptFormat: {
        useMutation: () => ({ mutateAsync: mocks.mutateAsync, isPending: mocks.isPending }),
      },
    },
  },
}));

vi.mock('@/lib/pharmacy/printer-test-print', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/printer-test-print')>()),
  openPrinterTestPage: mocks.openPage,
}));

import { PharmacyPrinterSettings } from './printer-settings-console';
import { PrinterTestPrintError } from '@/lib/pharmacy/printer-test-print';

const layout = { ...DEFAULT_RECEIPT_LAYOUT, footerText: 'Get well soon.' };
const query = (data?: unknown, extra: Partial<Query> = {}): Query => ({
  data,
  isPending: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
  ...extra,
});
const trpcError = (code: string) => Object.assign(new Error(code), { data: { code } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formatInputs = [];
  mocks.isPending = false;
  mocks.branches = query({
    branches: [
      { id: 'branch-a', name: 'Saddar', code: 'S1', city: 'Karachi' },
      { id: 'branch-b', name: 'Clifton', code: 'C1', city: 'Karachi' },
    ],
    timezone: 'Asia/Karachi',
  });
  mocks.format = query({ layout, output: 'THERMAL', revision: 3 });
});
afterEach(cleanup);

describe('PharmacyPrinterSettings', () => {
  it('shows the saved paper and saves a change with the shared layout carried through', async () => {
    mocks.mutateAsync.mockResolvedValue({
      layout: { ...layout, paperWidth: 58 },
      output: 'A4',
      revision: 4,
    });
    render(<PharmacyPrinterSettings canEdit />);
    expect(mocks.formatInputs.at(-1)).toEqual({ branchId: 'branch-a' });
    expect(screen.getByText('Thermal roll · 80 mm', { selector: '[data-slot="status-pill"]' }));
    const save = screen.getByRole('button', { name: 'Save printer settings' });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /58 mm roll/ }));
    fireEvent.click(screen.getByRole('radio', { name: /A4 sheet/ }));
    expect(screen.getByLabelText('Branch')).toBeDisabled();
    expect(screen.getByText('Save or discard your changes before switching branch.'));
    fireEvent.click(save);

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledOnce());
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      branchId: 'branch-a',
      revision: 3,
      layout: { ...layout, paperWidth: 58 },
      output: 'A4',
    });
    expect(mocks.cancel).toHaveBeenCalledWith({ branchId: 'branch-a' });
    expect(mocks.cancel.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.setData.mock.invocationCallOrder[0]!
    );
    expect(mocks.setData).toHaveBeenCalledWith(
      { branchId: 'branch-a' },
      expect.objectContaining({ revision: 4, output: 'A4' })
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Saved for Saddar. The counter opens with A4 sheet'
    );
  });

  it('reports a concurrent change honestly and reloads on request', async () => {
    mocks.mutateAsync.mockRejectedValue(trpcError('CONFLICT'));
    render(<PharmacyPrinterSettings canEdit />);
    fireEvent.click(screen.getByRole('radio', { name: /A4 sheet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save printer settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this branch’s printer settings, so nothing was saved.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved settings' }));
    expect(mocks.format.refetch).toHaveBeenCalledOnce();
    expect(screen.getByRole('radio', { name: /Thermal roll/ })).toBeChecked();
  });

  it.each([
    ['FORBIDDEN', 'You don’t have permission to change printer settings. Nothing was saved.'],
    ['INTERNAL_SERVER_ERROR', 'Your changes are still here; try Save again.'],
  ])('keeps the draft after a %s save failure', async (code, message) => {
    mocks.mutateAsync.mockRejectedValue(trpcError(code));
    render(<PharmacyPrinterSettings canEdit />);
    fireEvent.click(screen.getByRole('radio', { name: /A4 sheet/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save printer settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('radio', { name: /A4 sheet/ })).toBeChecked();
  });

  it('discards an unsaved change', () => {
    render(<PharmacyPrinterSettings canEdit />);
    fireEvent.click(screen.getByRole('radio', { name: /58 mm roll/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('radio', { name: /80 mm roll/ })).toBeChecked();
    expect(screen.getByLabelText('Branch')).toBeEnabled();
  });

  it('is read-only for a non-administrator, who can still test print', () => {
    render(<PharmacyPrinterSettings canEdit={false} />);
    expect(
      screen.getByText(/Only a workspace administrator can change saved printer settings/)
    ).toBeInTheDocument();
    for (const radio of screen
      .getAllByRole('radio')
      .filter((node) => node.getAttribute('name')?.match(/width|output/))) {
      expect(radio).toBeDisabled();
    }
    expect(screen.queryByRole('button', { name: 'Save printer settings' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Print test page' })).toBeEnabled();
  });

  it('explains a branch the member is not assigned to', () => {
    mocks.format = query(undefined, { isError: true, error: trpcError('FORBIDDEN') });
    render(<PharmacyPrinterSettings canEdit={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'You need counter access at Saddar to open its printer settings. Choose another branch above'
    );
    expect(screen.queryByRole('button', { name: 'Print test page' })).toBeNull();
  });

  it('offers a retry when saved settings cannot be read', () => {
    mocks.format = query(undefined, { isError: true, error: trpcError('INTERNAL_SERVER_ERROR') });
    render(<PharmacyPrinterSettings canEdit />);
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was changed.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.format.refetch).toHaveBeenCalledOnce();
  });

  it('shows loading, error and empty branch states', () => {
    mocks.branches = query(undefined, { isPending: true });
    const { rerender } = render(<PharmacyPrinterSettings canEdit />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading branches…');
    mocks.branches = query(undefined, { isError: true, error: trpcError('INTERNAL_SERVER_ERROR') });
    rerender(<PharmacyPrinterSettings canEdit />);
    expect(screen.getByRole('alert')).toHaveTextContent('Printer settings are unchanged.');
    mocks.branches = query({ branches: [], timezone: 'Asia/Karachi' });
    rerender(<PharmacyPrinterSettings canEdit />);
    expect(screen.getByText('No active branches')).toBeInTheDocument();
  });

  it('never claims the test page printed: the operator reports the result', () => {
    mocks.format = query({ layout: { ...layout, paperWidth: 58 }, output: 'THERMAL', revision: 1 });
    render(<PharmacyPrinterSettings canEdit />);
    expect(screen.getByLabelText('Paper')).toHaveValue('THERMAL_58');
    fireEvent.click(screen.getByRole('button', { name: 'Print test page' }));

    expect(mocks.openPage).toHaveBeenCalledOnce();
    const html = mocks.openPage.mock.calls[0]![0] as string;
    expect(html).toContain('Saddar');
    expect(html).toContain('width: 58mm;');
    expect(screen.getByText(/can’t see whether the page printed or the dialog was cancelled/));
    expect(screen.queryByText(/printed correctly on/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'It printed correctly' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'You confirmed the test page printed correctly on Thermal roll · 58 mm from this computer. This check is not saved'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Print test page again' }));
    fireEvent.click(screen.getByRole('button', { name: 'It didn’t print or looks wrong' }));
    const help = screen.getByRole('status');
    expect(within(help).getByText('If you pressed Cancel, nothing was sent to the printer.'));
    expect(mocks.openPage).toHaveBeenCalledTimes(2);
  });

  it('prints an Urdu A4 test page when chosen', () => {
    render(<PharmacyPrinterSettings canEdit />);
    fireEvent.change(screen.getByLabelText('Paper'), { target: { value: 'A4' } });
    fireEvent.click(screen.getByRole('radio', { name: 'اردو (Urdu)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Print test page' }));
    const html = mocks.openPage.mock.calls[0]![0] as string;
    expect(html).toContain('lang="ur" dir="rtl"');
    expect(html).toContain('@page { size: A4; margin: 10mm; }');
  });

  it.each([
    ['POPUP_BLOCKED', 'Your browser blocked the print window. Allow pop-ups for this site'],
    ['DIALOG_FAILED', 'The print dialog did not open. Select Print test page again.'],
  ] as const)('explains a %s failure and lets the operator retry', (code, message) => {
    mocks.openPage.mockImplementationOnce(() => {
      throw new PrinterTestPrintError(code);
    });
    render(<PharmacyPrinterSettings canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Print test page' }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    fireEvent.click(screen.getByRole('button', { name: 'Print test page again' }));
    expect(screen.getByRole('button', { name: 'It printed correctly' })).toBeInTheDocument();
  });

  // DEV-355: nothing restaurant-specific leaks into the pharmacy printer page.
  it('shows no restaurant kitchen routing or bridge enrollment', () => {
    render(<PharmacyPrinterSettings canEdit />);
    const text = document.body.textContent ?? '';
    for (const leak of [/kitchen/i, /KOT/, /KDS/, /print routing/i, /enrol/i, /station/i]) {
      expect(text).not.toMatch(leak);
    }
    expect(
      screen.getByText(/without the print dialog, is not\s+available here yet/)
    ).toBeInTheDocument();
  });

  it('puts USB first, keeps network, Bluetooth and A4, and names no printer brand', () => {
    render(<PharmacyPrinterSettings canEdit={false} />);
    const guide = screen
      .getByRole('heading', { name: 'How your printer connects' })
      .closest('[data-slot="section-card"]') as HTMLElement;
    const titles = within(guide)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('p')?.textContent);
    expect(titles).toEqual([
      'USB thermal printer (set up first)',
      'Network thermal printer (Wi-Fi or Ethernet)',
      'Bluetooth thermal printer',
      'A4 office printer',
    ]);
    expect(guide).toHaveTextContent(/Bluetooth Low Energy only cannot be used/);
    expect(guide).toHaveTextContent(/No printer model or connection is listed as supported/);
    for (const brand of [/epson/i, /canon/i, /pixma/i, /star micronics/i, /xprinter/i]) {
      expect(document.body.textContent).not.toMatch(brand);
    }
  });

  it('resets the test result when switching branch', () => {
    render(<PharmacyPrinterSettings canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Print test page' }));
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch-b' } });
    expect(mocks.formatInputs.at(-1)).toEqual({ branchId: 'branch-b' });
    expect(screen.queryByRole('button', { name: 'It printed correctly' })).toBeNull();
  });
});
