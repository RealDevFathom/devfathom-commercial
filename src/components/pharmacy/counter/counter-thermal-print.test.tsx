import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrintJobView } from '@/lib/pharmacy/print-job-ui';

type Bridge = { id: string; name: string; status: string; lastSeenAt: string; online: boolean };
type QueryStub = {
  data: unknown;
  isError: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  saved: null as unknown as QueryStub,
  status: null as unknown as QueryStub,
  jobData: undefined as unknown,
  jobError: null as Error | null,
  jobRefetch: vi.fn(),
  enqueue: vi.fn(),
  enqueuePending: false,
  retry: vi.fn(),
  setData: vi.fn(),
  savedQuery: vi.fn(),
  jobQuery: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyPrinting: { jobStatus: { setData: mocks.setData } } }),
    pharmacySales: {
      counterReceiptFormat: {
        useQuery: (input: unknown, options: unknown) => {
          mocks.savedQuery(input, options);
          return mocks.saved;
        },
      },
    },
    pharmacyPrinting: {
      printerStatus: { useQuery: () => mocks.status },
      enqueueReceipt: {
        useMutation: () => ({ mutateAsync: mocks.enqueue, isPending: mocks.enqueuePending }),
      },
      retryJob: { useMutation: () => ({ mutateAsync: mocks.retry, isPending: false }) },
      jobStatus: {
        useQuery: (input: unknown, options: { initialData?: unknown }) => {
          mocks.jobQuery(input, options);
          return {
            data: mocks.jobData ?? options.initialData,
            isError: mocks.jobError !== null,
            isFetching: false,
            error: mocks.jobError,
            refetch: mocks.jobRefetch,
          };
        },
      },
    },
  },
}));

import { CounterThermalPrint, type CounterThermalPrintProps } from './counter-thermal-print';

const query = (data: unknown, extra: Partial<QueryStub> = {}): QueryStub => ({
  data,
  isError: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
  ...extra,
});
const settings = (paperWidth: 58 | 80, output: 'THERMAL' | 'A4' = 'THERMAL') => ({
  layout: { paperWidth },
  output,
  revision: 1,
});
const bridge = (id: string, online = true): Bridge => ({
  id,
  name: `Counter ${id}`,
  status: 'ACTIVE',
  lastSeenAt: '2026-11-04T10:00:00.000Z',
  online,
});
const job = (overrides: Partial<PrintJobView> = {}): PrintJobView => ({
  id: 'job-1',
  kind: 'RECEIPT',
  saleId: 'sale-1',
  receiptNumber: 12,
  reprint: false,
  bridgeId: 'a',
  paperWidth: 80,
  state: 'QUEUED',
  attemptCount: 0,
  queuedAt: '2026-11-04T10:00:00.000Z',
  lastAttemptAt: null,
  acceptedAt: null,
  failureCode: null,
  paperConfirmed: false,
  retryable: false,
  retryRequiresPaperCheck: false,
  ...overrides,
});
const queuedResult = (view: PrintJobView, replayed = false) => ({
  status: 'QUEUED',
  replayed,
  job: view,
});
const networkError = () => Object.assign(new Error('Failed to fetch'), { data: undefined });

function props(overrides: Partial<CounterThermalPrintProps> = {}): CounterThermalPrintProps {
  return {
    branchId: 'branch-1',
    saleId: 'sale-1',
    receiptNumber: 12,
    locale: 'en',
    format: 'THERMAL',
    reprint: false,
    settled: true,
    printing: false,
    onBrowserPrint: vi.fn(),
    ...overrides,
  };
}

const sendButton = () => screen.queryByRole('button', { name: /^Send .*thermal printer/ });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saved = query(settings(80));
  mocks.status = query({ bridges: [bridge('a')], paperConfirmation: 'UNAVAILABLE' });
  mocks.jobData = undefined;
  mocks.jobError = null;
  mocks.enqueuePending = false;
});
afterEach(cleanup);

describe('routing safety: never reaches the bridge', () => {
  it.each(['A4', 'LABEL_50x30'] as const)('%s offers no bridge send', (format) => {
    render(<CounterThermalPrint {...props({ format })} />);
    expect(sendButton()).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/A4 prints through Print receipt/)).toBeTruthy();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('while saved settings load, without defaulting to a width', () => {
    mocks.saved = query(undefined);
    render(<CounterThermalPrint {...props()} />);
    expect(sendButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Checking this branch’s saved paper');
    expect(screen.queryByText(/80 mm/)).toBeNull();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('when saved settings fail, offering a recheck and the browser print', () => {
    mocks.saved = query(undefined, { isError: true, error: new Error('nope') });
    const input = props();
    render(<CounterThermalPrint {...input} />);
    expect(sendButton()).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('saved paper could not be read');
    fireEvent.click(screen.getByRole('button', { name: 'Check saved paper again' }));
    expect(mocks.saved.refetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Use browser print instead' }));
    expect(input.onBrowserPrint).toHaveBeenCalledOnce();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('while the bridge status loads', () => {
    mocks.status = query(undefined);
    render(<CounterThermalPrint {...props()} />);
    expect(sendButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Checking the thermal print bridge');
  });

  it('when the branch saved paper is A4', () => {
    mocks.saved = query(settings(80, 'A4'));
    render(<CounterThermalPrint {...props({ format: 'THERMAL' })} />);
    expect(sendButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('saved paper is A4');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    [58, 'THERMAL', 'saved 58 mm roll; switch Format to Thermal · 58 mm.'],
    [80, 'THERMAL_58', 'saved 80 mm roll; switch Format to Thermal · 80 mm.'],
  ] as const)('when the saved %i mm roll does not match %s', (width, format, text) => {
    mocks.saved = query(settings(width));
    render(<CounterThermalPrint {...props({ format })} />);
    expect(sendButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      `The thermal printer uses this branch’s ${text}`
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([[[]], [[bridge('a', false)]]])('when no bridge is online (%j)', (bridges) => {
    mocks.status = query({ bridges, paperConfirmation: 'UNAVAILABLE' });
    const input = props();
    render(<CounterThermalPrint {...input} />);
    expect(sendButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('No thermal print bridge is online');
    fireEvent.click(screen.getByRole('button', { name: 'Print receipt (browser)' }));
    expect(input.onBrowserPrint).toHaveBeenCalledOnce();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([{ settled: false }, { printing: true }])('disables the send when %j', (state) => {
    render(<CounterThermalPrint {...props(state)} />);
    expect(sendButton()).toBeDisabled();
  });

  it('shares the counter saved-paper cache options', () => {
    render(<CounterThermalPrint {...props()} />);
    expect(mocks.savedQuery).toHaveBeenCalledWith(
      { branchId: 'branch-1' },
      expect.objectContaining({ staleTime: 600_000, refetchOnWindowFocus: false, retry: false })
    );
  });
});

describe('sending', () => {
  it('sends the original without a request key and with the matching paper', async () => {
    mocks.saved = query(settings(58));
    mocks.enqueue.mockResolvedValue(queuedResult(job({ paperWidth: 58 })));
    render(<CounterThermalPrint {...props({ format: 'THERMAL_58' })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-1',
      saleId: 'sale-1',
      locale: 'en',
      reprint: false,
      paper: 'THERMAL_58',
    });
  });

  it('gives a reprint its own request key', async () => {
    mocks.enqueue.mockResolvedValue(queuedResult(job({ reprint: true })));
    render(<CounterThermalPrint {...props({ reprint: true })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reprint to thermal printer' }));
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        reprint: true,
        paper: 'THERMAL_80',
        requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
      })
    );
  });

  it('retries a network failure with the same key; a new click after Discard uses a new key', async () => {
    mocks.enqueue.mockRejectedValue(networkError());
    render(<CounterThermalPrint {...props({ reprint: true })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reprint to thermal printer' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch');
    expect(screen.getByRole('alert')).toHaveTextContent('not queued twice');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    // Item 2: while the outcome is uncertain, Send cannot mint a new key.
    expect(screen.getByRole('button', { name: 'Send reprint to thermal printer' })).toBeDisabled();
    expect(screen.getByText(/may already have\s+queued a job/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reprint to thermal printer' }));
    });
    const keys = mocks.enqueue.mock.calls.map(([input]) => input.requestKey);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each([
    ['the format switched to A4', () => props({ reprint: true, format: 'A4' }), /A4 prints/],
    [
      'the saved settings are loading',
      () => {
        mocks.saved = query(undefined);
        return props({ reprint: true });
      },
      /Checking this branch’s saved paper/,
    ],
    [
      'the saved settings errored',
      () => {
        mocks.saved = query(undefined, { isError: true, error: new Error('x') });
        return props({ reprint: true });
      },
      /saved paper could not be read/,
    ],
    [
      'the saved width now mismatches',
      () => {
        mocks.saved = query(settings(58));
        return props({ reprint: true });
      },
      /switch Format to Thermal · 58 mm/,
    ],
  ])('hides Try again when %s', async (_case, blockedProps, reason) => {
    mocks.enqueue.mockRejectedValue(networkError());
    const { rerender } = render(<CounterThermalPrint {...props({ reprint: true })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reprint to thermal printer' }));
    });
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    rerender(<CounterThermalPrint {...blockedProps()} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByText(/Try again is unavailable/)).toHaveTextContent(reason);
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it('hides Try again when the paper changed since the request', async () => {
    mocks.enqueue.mockRejectedValue(networkError());
    const { rerender } = render(<CounterThermalPrint {...props({ reprint: true })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reprint to thermal printer' }));
    });
    mocks.saved = query(settings(58));
    rerender(<CounterThermalPrint {...props({ reprint: true, format: 'THERMAL_58' })} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByText(/the paper changed since this request/)).toBeTruthy();
  });

  it('offers no same-key retry when the server refused the request', async () => {
    mocks.enqueue.mockRejectedValue(
      Object.assign(new Error('Print bridge not found.'), { data: { code: 'NOT_FOUND' } })
    );
    render(<CounterThermalPrint {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Print bridge not found.');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(mocks.status.refetch).toHaveBeenCalled();
  });

  it('blocks a double send while the request is pending', async () => {
    mocks.enqueue.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<CounterThermalPrint {...props({ reprint: true })} />);
    const button = screen.getByRole('button', { name: 'Send reprint to thermal printer' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Sending to thermal printer…' })).toBeDisabled();

    mocks.enqueuePending = true;
    rerender(<CounterThermalPrint {...props({ reprint: true, saleId: 'sale-2' })} />);
    expect(screen.getByRole('button', { name: 'Sending to thermal printer…' })).toBeDisabled();
  });
});

describe('after sending', () => {
  it('polls a queued job and reports SENT_TO_PRINTER without claiming paper', async () => {
    mocks.enqueue.mockResolvedValue(queuedResult(job()));
    const { rerender } = render(<CounterThermalPrint {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    const [input, options] = mocks.jobQuery.mock.lastCall!;
    expect(input).toEqual({ branchId: 'branch-1', jobId: 'job-1' });
    const interval = options.refetchInterval as (q: unknown) => number | false;
    expect(interval({ state: { data: { state: 'QUEUED' } } })).toBe(2_000);
    expect(interval({ state: { data: { state: 'SENDING' } } })).toBe(2_000);
    expect(interval({ state: { data: { state: 'SENT_TO_PRINTER' } } })).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for bridge');
    expect(sendButton()).toBeDisabled();

    mocks.jobData = job({ state: 'SENT_TO_PRINTER', acceptedAt: '2026-11-04T10:00:03.000Z' });
    rerender(<CounterThermalPrint {...props()} />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Sent to printer');
    expect(region).toHaveTextContent('check the printer');
    expect(screen.getByRole('region', { name: 'Thermal print queue' }).textContent).not.toMatch(
      /printed/i
    );

    // This sale now has a queued original, so the next send is a reprint with a key.
    mocks.enqueue.mockResolvedValue(queuedResult(job({ id: 'job-2', reprint: true })));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reprint to thermal printer' }));
    });
    expect(mocks.enqueue.mock.lastCall![0]).toEqual(
      expect.objectContaining({ reprint: true, requestKey: expect.any(String) })
    );
  });

  it('blocks Send while a job may have printed, but not after EXPIRED', async () => {
    mocks.enqueue.mockResolvedValue(
      queuedResult(job({ state: 'FAILED', retryable: true, retryRequiresPaperCheck: true }))
    );
    const { rerender } = render(<CounterThermalPrint {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(screen.getByRole('button', { name: 'Send reprint to thermal printer' })).toBeDisabled();
    expect(screen.getByText(/use Resend this job below/)).toBeTruthy();
    mocks.jobData = job({ state: 'EXPIRED', retryable: true, retryRequiresPaperCheck: false });
    rerender(<CounterThermalPrint {...props()} />);
    expect(screen.getByRole('button', { name: 'Send reprint to thermal printer' })).toBeEnabled();
  });

  it('stops polling on a status read error and offers a manual check', async () => {
    mocks.enqueue.mockResolvedValue(queuedResult(job()));
    const { rerender } = render(<CounterThermalPrint {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    const interval = mocks.jobQuery.mock.lastCall![1].refetchInterval as (
      q: unknown
    ) => number | false;
    expect(interval({ state: { status: 'error', data: { state: 'QUEUED' } } })).toBe(false);
    expect(interval({ state: { status: 'success', data: { state: 'QUEUED' } } })).toBe(2_000);
    mocks.jobError = new Error('Print job not found.');
    rerender(<CounterThermalPrint {...props()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Print job not found.');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(mocks.jobRefetch).toHaveBeenCalledOnce();
  });

  it('says a replayed reprint was already queued, not the original', async () => {
    mocks.enqueue.mockResolvedValue(queuedResult(job({ reprint: true }), true));
    render(<CounterThermalPrint {...props({ reprint: true })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reprint to thermal printer' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'This reprint was already queued; showing its status.'
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('original');
  });

  it('reports every QUEUED send, replays included, but not a fallback', async () => {
    const onThermalQueued = vi.fn();
    mocks.enqueue.mockResolvedValueOnce({
      status: 'FALLBACK',
      code: 'SETTINGS_CHANGED',
      fallback: 'BROWSER_OS',
      message: 'x',
    });
    render(<CounterThermalPrint {...props({ onThermalQueued })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(onThermalQueued).not.toHaveBeenCalled();
    expect(mocks.saved.refetch).toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('printer settings changed');
    mocks.enqueue.mockResolvedValueOnce(queuedResult(job({ state: 'SENT_TO_PRINTER' }), true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(onThermalQueued).toHaveBeenCalledExactlyOnceWith('sale-1');
  });

  it('explains a replayed original', async () => {
    mocks.enqueue.mockResolvedValue(queuedResult(job({ state: 'SENT_TO_PRINTER' }), true));
    render(<CounterThermalPrint {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('already queued');
  });

  it('shows the fallback text and the browser print on FALLBACK', async () => {
    mocks.enqueue.mockResolvedValue({
      status: 'FALLBACK',
      code: 'UNSUPPORTED_PRINT_TEXT',
      fallback: 'BROWSER_OS',
      message: 'server text',
    });
    const input = props({ locale: 'ur' });
    render(<CounterThermalPrint {...input} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The thermal printer cannot print this text (for example Urdu). Nothing was sent.'
    );
    expect(screen.getByText('Not sent')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use browser print instead' }));
    expect(input.onBrowserPrint).toHaveBeenCalledOnce();
    // Nothing was queued, so the next click is still the original.
    expect(screen.getByRole('button', { name: 'Send to thermal printer' })).toBeEnabled();
  });

  it('needs the paper check before resending an unconfirmed job', async () => {
    const unconfirmed = job({
      state: 'UNCONFIRMED',
      retryable: true,
      retryRequiresPaperCheck: true,
    });
    const requeued = job({ attemptCount: 1 });
    mocks.enqueue.mockResolvedValue(queuedResult(unconfirmed));
    mocks.retry.mockResolvedValue(requeued);
    render(<CounterThermalPrint {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Not confirmed');
    const resend = screen.getByRole('button', { name: 'Resend this job' });
    expect(resend).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I checked the printer: this receipt did not come out',
      })
    );
    expect(resend).toBeEnabled();
    await act(async () => {
      fireEvent.click(resend);
    });
    expect(mocks.retry).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch-1',
      jobId: 'job-1',
      confirmNoPaperPrinted: true,
    });
    expect(mocks.setData).toHaveBeenCalledWith({ branchId: 'branch-1', jobId: 'job-1' }, requeued);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for bridge');
  });

  it('resends a failed job without the paper check when none is required', async () => {
    mocks.enqueue.mockResolvedValue(
      queuedResult(job({ state: 'EXPIRED', retryable: true, retryRequiresPaperCheck: false }))
    );
    mocks.retry.mockResolvedValue(job());
    render(<CounterThermalPrint {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(screen.queryByRole('checkbox')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resend this job' }));
    });
    expect(mocks.retry).toHaveBeenCalledWith(
      expect.objectContaining({ confirmNoPaperPrinted: false })
    );
  });
});

describe('several bridges', () => {
  it('requires choosing an online bridge and sends its id', async () => {
    mocks.status = query({
      bridges: [bridge('a'), bridge('b'), bridge('c', false)],
      paperConfirmation: 'UNAVAILABLE',
    });
    mocks.enqueue.mockResolvedValue(queuedResult(job({ bridgeId: 'b' })));
    render(<CounterThermalPrint {...props()} />);
    const select = screen.getByLabelText('Thermal printer');
    expect(within(select).getByRole('option', { name: 'Counter c (offline)' })).toBeDisabled();
    expect(sendButton()).toBeDisabled();
    fireEvent.change(select, { target: { value: 'b' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ bridgeId: 'b' }));
  });

  it('sends no bridge id when the branch has one bridge', async () => {
    mocks.enqueue.mockResolvedValue(queuedResult(job()));
    render(<CounterThermalPrint {...props()} />);
    expect(screen.queryByLabelText('Thermal printer')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
    });
    expect(mocks.enqueue.mock.lastCall![0]).not.toHaveProperty('bridgeId');
  });
});
