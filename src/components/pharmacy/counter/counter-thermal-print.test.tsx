import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  retry: vi.fn(),
  setData: vi.fn(),
  status: { data: undefined as unknown, isError: false },
  statusInput: undefined as unknown,
  statusOptions: undefined as
    | {
        enabled?: boolean;
        refetchInterval?: (query: { state: { data?: unknown } }) => number | false;
      }
    | undefined,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyPrinting: { jobStatus: { setData: mocks.setData } } }),
    pharmacyPrinting: {
      enqueueReceipt: {
        useMutation: () => ({ mutateAsync: mocks.enqueue, isPending: false }),
      },
      retryJob: { useMutation: () => ({ mutateAsync: mocks.retry, isPending: false }) },
      jobStatus: {
        useQuery: (input: unknown, options: typeof mocks.statusOptions) => {
          mocks.statusInput = input;
          mocks.statusOptions = options;
          return mocks.status;
        },
      },
    },
  },
}));

import {
  CounterThermalPrint,
  THERMAL_STATE_TEXT,
  THERMAL_STATUS_POLL_MS,
} from './counter-thermal-print';

function job(state: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    state,
    reprint: false,
    failureCode: null,
    retryable: ['FAILED', 'UNCONFIRMED', 'EXPIRED'].includes(state),
    retryRequiresPaperCheck: ['FAILED', 'UNCONFIRMED'].includes(state),
    ...extra,
  };
}

const props = {
  branchId: 'branch-1',
  saleId: 'sale-1',
  locale: 'en' as const,
  format: 'THERMAL' as const,
};

beforeEach(() => {
  mocks.enqueue.mockReset();
  mocks.retry.mockReset();
  mocks.setData.mockReset();
  mocks.status = { data: undefined, isError: false };
});
afterEach(cleanup);

async function send() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send to thermal printer' }));
  });
}

describe('CounterThermalPrint', () => {
  it('queues the settled receipt by identifiers only and shows the bridge state in plain words', async () => {
    mocks.enqueue.mockResolvedValue({ status: 'QUEUED', replayed: false, job: job('QUEUED') });
    render(<CounterThermalPrint {...props} />);
    await send();

    expect(mocks.enqueue).toHaveBeenCalledWith({
      branchId: 'branch-1',
      saleId: 'sale-1',
      locale: 'en',
      paper: 'THERMAL_80',
      requestKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
    });
    expect(screen.getByText(THERMAL_STATE_TEXT.QUEUED.text)).toBeTruthy();
    expect(mocks.statusInput).toEqual({ branchId: 'branch-1', jobId: 'job-1' });
    expect(mocks.statusOptions?.enabled).toBe(true);
    // A second copy is not offered while the first is still on its way.
    expect(
      screen.getByRole('button', { name: 'Send another copy to thermal printer' })
    ).toBeDisabled();
  });

  it('uses a fresh request key for every click', async () => {
    mocks.enqueue.mockResolvedValue({ status: 'QUEUED', replayed: false, job: job('EXPIRED') });
    render(<CounterThermalPrint {...props} format="THERMAL_58" />);
    await send();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send another copy to thermal printer' }));
    });
    const [first, second] = mocks.enqueue.mock.calls.map(([input]) => input);
    expect(first.paper).toBe('THERMAL_58');
    expect(first.requestKey).not.toBe(second.requestKey);
  });

  it('never says the receipt printed, even after the printer accepted it', async () => {
    mocks.enqueue.mockResolvedValue({ status: 'QUEUED', replayed: false, job: job('QUEUED') });
    const view = render(<CounterThermalPrint {...props} />);
    await send();
    mocks.status = { data: job('SENT_TO_PRINTER'), isError: false };
    view.rerender(<CounterThermalPrint {...props} />);

    expect(screen.getByText('Sent to printer')).toBeTruthy();
    const words = screen.getByRole('status').textContent ?? '';
    expect(words).toMatch(/cannot see the paper/);
    expect(words).not.toMatch(/\bprinted\b/i);
    // Polling stops once the bridge reported a final state.
    const interval = mocks.statusOptions!.refetchInterval!;
    expect(interval({ state: { data: job('SENT_TO_PRINTER') } })).toBe(false);
    expect(interval({ state: { data: job('SENDING') } })).toBe(THERMAL_STATUS_POLL_MS);
    expect(screen.queryByRole('button', { name: 'Retry thermal print' })).toBeNull();
  });

  it('asks for a paper check before retrying a failed or unanswered job', async () => {
    mocks.enqueue.mockResolvedValue({
      status: 'QUEUED',
      replayed: false,
      job: job('FAILED', { failureCode: 'TRANSPORT_FAILED' }),
    });
    mocks.retry.mockResolvedValue(job('QUEUED'));
    render(<CounterThermalPrint {...props} />);
    await send();

    expect(screen.getByText(THERMAL_STATE_TEXT.FAILED.text)).toBeTruthy();
    expect(screen.getByText(/did not accept it/)).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry thermal print' });
    expect(retry).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(retry).toBeEnabled();
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(mocks.retry).toHaveBeenCalledWith({
      branchId: 'branch-1',
      jobId: 'job-1',
      confirmNoPaperPrinted: true,
    });
    expect(screen.getByText(THERMAL_STATE_TEXT.QUEUED.text)).toBeTruthy();
    expect(mocks.setData).toHaveBeenLastCalledWith(
      { branchId: 'branch-1', jobId: 'job-1' },
      expect.objectContaining({ state: 'QUEUED' })
    );
  });

  it('retries an expired job without a paper check', async () => {
    mocks.enqueue.mockResolvedValue({ status: 'QUEUED', replayed: false, job: job('EXPIRED') });
    mocks.retry.mockResolvedValue(job('QUEUED'));
    render(<CounterThermalPrint {...props} />);
    await send();
    expect(screen.getByText(THERMAL_STATE_TEXT.EXPIRED.text)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry thermal print' }));
    });
    expect(mocks.retry).toHaveBeenCalledWith({
      branchId: 'branch-1',
      jobId: 'job-1',
      confirmNoPaperPrinted: false,
    });
  });

  it('shows the server fallback when no bridge is set up and queues nothing', async () => {
    mocks.enqueue.mockResolvedValue({
      status: 'FALLBACK',
      code: 'NO_BRIDGE',
      fallback: 'BROWSER_OS',
      message: 'No thermal print bridge is set up for this branch. Use the browser print dialog.',
    });
    render(<CounterThermalPrint {...props} />);
    await send();
    expect(screen.getByRole('alert')).toHaveTextContent(/No thermal print bridge is set up/);
    expect(screen.getByRole('button', { name: 'Send to thermal printer' })).toBeEnabled();
  });

  it('explains Urdu text in plain words and shows server refusals', async () => {
    mocks.enqueue.mockResolvedValueOnce({
      status: 'FALLBACK',
      code: 'UNSUPPORTED_PRINT_TEXT',
      fallback: 'BROWSER_OS',
      message: 'Unsupported printer text. Use a browser/OS-rendered receipt.',
    });
    render(<CounterThermalPrint {...props} locale="ur" />);
    await send();
    expect(screen.getByRole('alert')).toHaveTextContent(/Urdu or other non-Latin characters/);

    mocks.enqueue.mockRejectedValueOnce(
      new Error('This bill is not settled, so it has no receipt to print.')
    );
    await send();
    expect(screen.getByRole('alert')).toHaveTextContent('This bill is not settled');
  });

  it('cannot send an A4 receipt to the thermal printer', () => {
    render(<CounterThermalPrint {...props} format="A4" />);
    expect(screen.getByRole('button', { name: 'Send to thermal printer' })).toBeDisabled();
    expect(screen.getByText(/Choose a thermal format/)).toBeTruthy();
  });
});
