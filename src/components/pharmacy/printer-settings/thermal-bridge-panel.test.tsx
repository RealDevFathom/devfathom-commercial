import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINT_FALLBACK_TEXT, type PrintJobView } from '@/lib/pharmacy/print-job-ui';

type Query = {
  data?: unknown;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
};
type Call = { input: unknown; opts: Record<string, unknown> | undefined };
const mutation = () => ({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false });

const mocks = vi.hoisted(() => ({
  status: undefined as unknown as Query,
  bridges: undefined as unknown as Query,
  job: undefined as unknown as Query,
  statusCalls: [] as Call[],
  bridgesCalls: [] as Call[],
  jobCalls: [] as Call[],
  enroll: undefined as unknown as ReturnType<typeof mutation>,
  revoke: undefined as unknown as ReturnType<typeof mutation>,
  enqueue: undefined as unknown as ReturnType<typeof mutation>,
  retry: undefined as unknown as ReturnType<typeof mutation>,
  invalidate: vi.fn(),
  setData: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyPrinting: {
        printerStatus: { invalidate: mocks.invalidate },
        bridges: { invalidate: mocks.invalidate },
        jobStatus: { setData: mocks.setData },
      },
    }),
    pharmacyPrinting: {
      printerStatus: {
        useQuery: (input: unknown, opts?: Record<string, unknown>) => {
          mocks.statusCalls.push({ input, opts });
          return mocks.status;
        },
      },
      bridges: {
        useQuery: (input: unknown, opts?: Record<string, unknown>) => {
          mocks.bridgesCalls.push({ input, opts });
          return mocks.bridges;
        },
      },
      jobStatus: {
        useQuery: (input: unknown, opts?: Record<string, unknown>) => {
          mocks.jobCalls.push({ input, opts });
          return mocks.job;
        },
      },
      enrollBridge: { useMutation: () => mocks.enroll },
      revokeBridge: { useMutation: () => mocks.revoke },
      enqueueTestPage: { useMutation: () => mocks.enqueue },
      retryJob: { useMutation: () => mocks.retry },
    },
  },
}));

import { ThermalBridgePanel, type ThermalBridgePanelProps } from './thermal-bridge-panel';

const query = (data?: unknown, extra: Partial<Query> = {}): Query => ({
  data,
  isPending: false,
  isError: false,
  isSuccess: !extra.isPending && !extra.isError,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
  ...extra,
});
const trpcError = (code: string, message = code) =>
  Object.assign(new Error(message), { data: { code } });

const bridge = (id: string, name: string, online: boolean) => ({
  id,
  name,
  status: 'ACTIVE' as const,
  lastSeenAt: online ? '2026-11-04T09:30:00.000Z' : null,
  online,
});
const jobView = (extra: Partial<PrintJobView> = {}): PrintJobView => ({
  id: 'job-1',
  kind: 'TEST_PAGE',
  saleId: null,
  receiptNumber: null,
  reprint: false,
  bridgeId: 'bridge-1',
  paperWidth: 80,
  state: 'QUEUED',
  attemptCount: 0,
  queuedAt: '2026-11-04T09:30:00.000Z',
  lastAttemptAt: null,
  acceptedAt: null,
  failureCode: null,
  paperConfirmed: false,
  retryable: false,
  retryRequiresPaperCheck: false,
  ...extra,
});

const props = (extra: Partial<ThermalBridgePanelProps> = {}): ThermalBridgePanelProps => ({
  branchId: 'branch-a',
  branchName: 'Saddar',
  canEdit: false,
  savedPaper: { paper: 'THERMAL_80', output: 'THERMAL' },
  ...extra,
});
const sendButton = () => screen.getByRole('button', { name: 'Send test page to thermal printer' });
const panelText = () => document.body.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.statusCalls = [];
  mocks.bridgesCalls = [];
  mocks.jobCalls = [];
  mocks.status = query({
    bridges: [bridge('bridge-1', 'Front counter', true)],
    paperConfirmation: 'UNAVAILABLE',
  });
  mocks.bridges = query([
    {
      ...bridge('bridge-1', 'Front counter', true),
      printerId: '/dev/usb/lp0',
      createdAt: '2026-11-01T08:00:00.000Z',
    },
    {
      ...bridge('bridge-0', 'Old till', false),
      status: 'REVOKED' as const,
      printerId: 'tcp://192.168.1.50:9100',
      createdAt: '2026-10-01T08:00:00.000Z',
    },
  ]);
  mocks.job = query(undefined, { isPending: true });
  mocks.enroll = mutation();
  mocks.revoke = mutation();
  mocks.enqueue = mutation();
  mocks.retry = mutation();
});
afterEach(cleanup);

describe('ThermalBridgePanel status', () => {
  it('shows online and offline bridges with a label, not colour alone, and no paper claim', () => {
    mocks.status = query({
      bridges: [
        bridge('bridge-1', 'Front counter', true),
        bridge('bridge-2', 'Back office', false),
      ],
      paperConfirmation: 'UNAVAILABLE',
    });
    render(<ThermalBridgePanel {...props()} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Thermal print bridge' }));
    const list = screen.getByRole('list', { name: 'Print bridges for Saddar' });
    const [front, back] = within(list).getAllByRole('listitem');
    expect(within(front!).getByText('Online', { selector: '[data-slot="status-pill"]' }));
    expect(front).toHaveTextContent('Last seen');
    expect(within(back!).getByText('Offline', { selector: '[data-slot="status-pill"]' }));
    expect(back).toHaveTextContent('Not seen yet');
    expect(panelText()).toMatch(/DevFathom cannot see paper/);
    expect(mocks.statusCalls.at(-1)?.input).toEqual({ branchId: 'branch-a' });
  });

  it('explains an empty branch', () => {
    mocks.status = query({ bridges: [], paperConfirmation: 'UNAVAILABLE' });
    render(<ThermalBridgePanel {...props()} />);
    expect(screen.getByText('No print bridge is enrolled for Saddar')).toBeInTheDocument();
    expect(panelText()).toMatch(
      /small program on the computer the thermal printer is connected to/
    );
    expect(sendButton()).toBeDisabled();
  });

  it('shows loading, error with retry, and forbidden states', () => {
    mocks.status = query(undefined, { isPending: true });
    const { rerender } = render(<ThermalBridgePanel {...props()} />);
    expect(screen.getByText('Checking the print bridge for Saddar…')).toBeInTheDocument();

    mocks.status = query(undefined, { isError: true, error: trpcError('INTERNAL_SERVER_ERROR') });
    rerender(<ThermalBridgePanel {...props()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The bridge status could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.status.refetch).toHaveBeenCalledOnce();

    mocks.status = query(undefined, { isError: true, error: trpcError('FORBIDDEN') });
    rerender(<ThermalBridgePanel {...props()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'You need counter access at Saddar to see its print bridge.'
    );
    expect(screen.queryByRole('button', { name: 'Send test page to thermal printer' })).toBeNull();
  });
});

describe('ThermalBridgePanel administration', () => {
  it('hides enrolment, revoke and printer targets from a non-administrator', () => {
    render(<ThermalBridgePanel {...props()} />);
    expect(screen.queryByRole('button', { name: 'Enroll bridge' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull();
    expect(screen.queryByLabelText('Printer target')).toBeNull();
    expect(panelText()).not.toContain('/dev/usb/lp0');
    expect(mocks.bridgesCalls.some((call) => call.opts?.enabled !== false)).toBe(false);
  });

  it('lists every bridge with its target and mutes revoked ones', () => {
    render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    expect(mocks.bridgesCalls.at(-1)).toMatchObject({
      input: { branchId: 'branch-a' },
      opts: { enabled: true },
    });
    const list = screen.getByRole('list', { name: 'Enrolled bridges for Saddar' });
    const [active, revoked] = within(list).getAllByRole('listitem');
    expect(active).toHaveTextContent('/dev/usb/lp0');
    expect(revoked).toHaveTextContent('tcp://192.168.1.50:9100');
    expect(within(revoked!).getByText('Revoked', { selector: '[data-slot="status-pill"]' }));
    expect(revoked!.className).toContain('text-text-muted');
    expect(within(revoked!).queryByRole('button')).toBeNull();
  });

  it('offers USB first and follows the chosen connection in the target placeholder', () => {
    render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    const connection = screen.getByLabelText('Connection');
    expect(
      within(connection)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual([
      'USB – Windows',
      'USB – macOS',
      'USB – Linux/macOS device',
      'Network',
      'Bluetooth – Windows',
      'Bluetooth – macOS/Linux serial',
    ]);
    const target = screen.getByLabelText('Printer target');
    expect(target).toHaveAttribute('placeholder', 'queue:///Receipt%20Printer');
    fireEvent.change(connection, { target: { value: 'network' } });
    expect(target).toHaveAttribute('placeholder', 'tcp://192.168.1.50:9100');
    fireEvent.change(connection, { target: { value: 'bluetooth-serial' } });
    expect(target).toHaveAttribute('placeholder', 'serial:///dev/cu.<name> or /dev/rfcomm0');
  });

  it('shows the credential once, keeps it out of storage and logs, and removes it on dismiss', async () => {
    const log = vi.spyOn(console, 'log');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mocks.enroll.mutateAsync.mockResolvedValue({
      bridge: { ...bridge('bridge-9', 'Front counter', false), printerId: '/dev/usb/lp0' },
      credential: 'pb_secret_credential_123',
      notice:
        'Store this credential in the bridge host’s owner-only token file now. It is not shown again.',
    });
    render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    fireEvent.change(screen.getByLabelText('Bridge name'), {
      target: { value: ' Front counter ' },
    });
    fireEvent.change(screen.getByLabelText('Printer target'), {
      target: { value: '/dev/usb/lp0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enroll bridge' }));

    const secret = await screen.findByLabelText('Bridge credential');
    expect(mocks.enroll.mutateAsync).toHaveBeenCalledWith({
      branchId: 'branch-a',
      name: 'Front counter',
      printerId: '/dev/usb/lp0',
    });
    expect(secret).toHaveValue('pb_secret_credential_123');
    expect(secret).toHaveAttribute('readonly');
    expect(screen.getAllByDisplayValue('pb_secret_credential_123')).toHaveLength(1);
    expect(panelText()).toContain('It is not shown again.');
    expect(mocks.invalidate).toHaveBeenCalledWith({ branchId: 'branch-a' });
    expect(window.location.href).not.toContain('pb_secret');
    expect(JSON.stringify({ ...localStorage })).not.toContain('pb_secret');
    expect(log.mock.calls.flat().join(' ')).not.toContain('pb_secret');

    fireEvent.click(screen.getByRole('button', { name: 'Copy credential' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('pb_secret_credential_123'));
    expect(await screen.findByText(/Copied\./)).toBeInTheDocument();

    const resets = mocks.enroll.reset.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'I’ve stored it' }));
    expect(mocks.enroll.reset.mock.calls.length).toBeGreaterThan(resets);
    expect(screen.queryByLabelText('Bridge credential')).toBeNull();
    expect(document.body.innerHTML).not.toContain('pb_secret');
    log.mockRestore();
  });

  it('drops a shown credential when the branch changes', async () => {
    mocks.enroll.mutateAsync.mockResolvedValue({
      bridge: { ...bridge('bridge-9', 'Till', false), printerId: '/dev/usb/lp0' },
      credential: 'pb_secret_credential_456',
      notice: 'It is not shown again.',
    });
    const { rerender } = render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    fireEvent.change(screen.getByLabelText('Bridge name'), { target: { value: 'Till' } });
    fireEvent.change(screen.getByLabelText('Printer target'), {
      target: { value: '/dev/usb/lp0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enroll bridge' }));
    await screen.findByLabelText('Bridge credential');
    rerender(
      <ThermalBridgePanel
        {...props({ canEdit: true, branchId: 'branch-b', branchName: 'Clifton' })}
      />
    );
    expect(document.body.innerHTML).not.toContain('pb_secret');
    expect(mocks.enroll.reset).toHaveBeenCalled();
  });

  it('shows a rejected printer target on the field', async () => {
    const message = 'Use tcp://host:9100, queue:///encoded-name, or a /dev/ path.';
    mocks.enroll.mutateAsync.mockRejectedValue(trpcError('BAD_REQUEST', message));
    render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    fireEvent.change(screen.getByLabelText('Bridge name'), { target: { value: 'Front' } });
    const target = screen.getByLabelText('Printer target');
    fireEvent.change(target, { target: { value: 'lp0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enroll bridge' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(target).toHaveAttribute('aria-invalid', 'true');
    expect(target).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(target).toHaveValue('lp0');
    expect(screen.queryByLabelText('Bridge credential')).toBeNull();
  });

  it('requires a name before calling the server', () => {
    render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enroll bridge' }));
    expect(screen.getByLabelText('Bridge name')).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.enroll.mutateAsync).not.toHaveBeenCalled();
  });

  it('revokes only after an explained confirmation', async () => {
    mocks.revoke.mutateAsync.mockResolvedValue({ bridgeId: 'bridge-1', status: 'REVOKED' });
    render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }));
    expect(mocks.revoke.mutateAsync).not.toHaveBeenCalled();
    const confirm = screen.getByRole('group', { name: /Revoke Front counter\?/ });
    expect(confirm).toHaveTextContent(/jobs stop going to this bridge/);
    expect(confirm).toHaveTextContent(/enroll it as a new bridge/);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep bridge' }));
    expect(screen.queryByRole('group', { name: /Revoke Front counter\?/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke bridge' }));
    await waitFor(() =>
      expect(mocks.revoke.mutateAsync).toHaveBeenCalledWith({
        branchId: 'branch-a',
        bridgeId: 'bridge-1',
      })
    );
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
  });
});

describe('ThermalBridgePanel test page', () => {
  it('is disabled for A4 output', () => {
    render(
      <ThermalBridgePanel {...props({ savedPaper: { paper: 'THERMAL_80', output: 'A4' } })} />
    );
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAccessibleDescription(
      'This branch prints on A4; use the browser test print above.'
    );
  });

  it('is disabled when no bridge is online', () => {
    mocks.status = query({
      bridges: [bridge('bridge-1', 'Front counter', false)],
      paperConfirmation: 'UNAVAILABLE',
    });
    render(<ThermalBridgePanel {...props()} />);
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAccessibleDescription(/No print bridge is online/);
  });

  it('polls a queued job until it settles and never says printed', async () => {
    mocks.enqueue.mutateAsync.mockResolvedValue({
      status: 'QUEUED',
      replayed: false,
      job: jobView(),
    });
    const { rerender } = render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    await screen.findByText('Waiting for bridge', { selector: '[data-slot="status-pill"]' });
    const sent = mocks.enqueue.mutateAsync.mock.calls[0]![0];
    expect(sent).toMatchObject({ branchId: 'branch-a', paper: 'THERMAL_80' });
    expect(sent).not.toHaveProperty('bridgeId');

    const poll = mocks.jobCalls.at(-1)!;
    expect(poll.input).toEqual({ branchId: 'branch-a', jobId: 'job-1' });
    expect(poll.opts).toMatchObject({ enabled: true });
    const interval = poll.opts!.refetchInterval as (q: { state: { data?: unknown } }) => unknown;
    expect(interval({ state: { data: undefined } })).toBe(2_000);
    expect(interval({ state: { data: jobView({ state: 'SENDING' }) } })).toBe(2_000);
    expect(sendButton()).toBeDisabled();

    const done = jobView({ state: 'SENT_TO_PRINTER', acceptedAt: '2026-11-04T09:30:05.000Z' });
    mocks.job = query(done);
    rerender(<ThermalBridgePanel {...props()} />);
    expect(interval({ state: { data: done } })).toBe(false);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Sent to printer');
    expect(region).toHaveTextContent('check the printer');
    expect(panelText()).not.toMatch(/printed/i);
    expect(sendButton()).toBeEnabled();
  });

  it('shows the fallback text when nothing was queued', async () => {
    mocks.enqueue.mutateAsync.mockResolvedValue({
      status: 'FALLBACK',
      code: 'BRIDGE_OFFLINE',
      fallback: 'BROWSER_OS',
      message: 'server text',
    });
    render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    expect(await screen.findByText(PRINT_FALLBACK_TEXT.BRIDGE_OFFLINE)).toBeInTheDocument();
    expect(mocks.jobCalls.some((call) => call.opts?.enabled === true)).toBe(false);
  });

  it('requires the paper check before a retry, then resumes polling', async () => {
    const failed = jobView({
      state: 'UNCONFIRMED',
      retryable: true,
      retryRequiresPaperCheck: true,
    });
    mocks.enqueue.mutateAsync.mockResolvedValue({ status: 'QUEUED', replayed: false, job: failed });
    const requeued = jobView({ state: 'QUEUED', attemptCount: 1 });
    mocks.retry.mutateAsync.mockResolvedValue(requeued);
    render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());

    const again = await screen.findByRole('button', { name: 'Send the same test page again' });
    expect(again).toBeDisabled();
    const check = screen.getByRole('checkbox', {
      name: 'I checked the printer: no test page came out',
    });
    expect(check).toBeRequired();
    fireEvent.click(check);
    expect(again).toBeEnabled();
    fireEvent.click(again);

    await waitFor(() =>
      expect(mocks.retry.mutateAsync).toHaveBeenCalledWith({
        branchId: 'branch-a',
        jobId: 'job-1',
        confirmNoPaperPrinted: true,
      })
    );
    await waitFor(() =>
      expect(mocks.setData).toHaveBeenCalledWith({ branchId: 'branch-a', jobId: 'job-1' }, requeued)
    );
    expect(
      await screen.findByText('Waiting for bridge', { selector: '[data-slot="status-pill"]' })
    );
    const interval = mocks.jobCalls.at(-1)!.opts!.refetchInterval as (q: {
      state: { data?: unknown };
    }) => unknown;
    expect(interval({ state: { data: requeued } })).toBe(2_000);
  });

  it('shows the server message when a retry is refused', async () => {
    const failed = jobView({ state: 'FAILED', retryable: true, retryRequiresPaperCheck: false });
    mocks.enqueue.mutateAsync.mockResolvedValue({ status: 'QUEUED', replayed: false, job: failed });
    mocks.retry.mutateAsync.mockRejectedValue(
      trpcError('PRECONDITION_FAILED', 'The thermal print bridge is offline.')
    );
    render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Send the same test page again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The thermal print bridge is offline.'
    );
    expect(mocks.retry.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ confirmNoPaperPrinted: false })
    );
  });

  it('reuses the request key after a network error and uses a new one for a new click', async () => {
    mocks.enqueue.mutateAsync
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({
        status: 'FALLBACK',
        code: 'NO_BRIDGE',
        fallback: 'BROWSER_OS',
        message: '',
      });
    render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.enqueue.mutateAsync).toHaveBeenCalledTimes(2));
    await screen.findByText(PRINT_FALLBACK_TEXT.NO_BRIDGE);
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.enqueue.mutateAsync).toHaveBeenCalledTimes(3));

    const keys = mocks.enqueue.mutateAsync.mock.calls.map(
      (call) => (call[0] as { requestKey: string }).requestKey
    );
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('shows a definitive server error without offering a same-request retry', async () => {
    mocks.enqueue.mutateAsync.mockRejectedValue(
      trpcError('BAD_REQUEST', 'This branch has more than one thermal printer. Choose one.')
    );
    render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose one.');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('asks which bridge to use when two are online', async () => {
    mocks.status = query({
      bridges: [bridge('bridge-1', 'Front counter', true), bridge('bridge-2', 'Back office', true)],
      paperConfirmation: 'UNAVAILABLE',
    });
    mocks.enqueue.mutateAsync.mockResolvedValue({
      status: 'QUEUED',
      replayed: false,
      job: jobView({ bridgeId: 'bridge-2' }),
    });
    render(<ThermalBridgePanel {...props()} />);
    const select = screen.getByLabelText('Bridge');
    expect(select).toHaveValue('bridge-1');
    fireEvent.change(select, { target: { value: 'bridge-2' } });
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(mocks.enqueue.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ bridgeId: 'bridge-2', paper: 'THERMAL_80' })
      )
    );
  });

  it('has no bridge choice with a single bridge', () => {
    render(<ThermalBridgePanel {...props()} />);
    expect(screen.queryByLabelText('Bridge')).toBeNull();
  });
});

describe('ThermalBridgePanel review fixes', () => {
  it('holds Send while an unanswered request is unresolved; Discard allows a new key', async () => {
    mocks.enqueue.mutateAsync
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({
        status: 'FALLBACK',
        code: 'NO_BRIDGE',
        fallback: 'BROWSER_OS',
        message: '',
      });
    render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    const discard = await screen.findByRole('button', { name: 'Discard this request' });
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAccessibleDescription(
      /Try the unanswered request again, or discard it/
    );
    fireEvent.click(sendButton());
    expect(mocks.enqueue.mutateAsync).toHaveBeenCalledTimes(1);
    expect(panelText()).toMatch(/a test page may already have been queued/);

    fireEvent.click(discard);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(sendButton()).toBeEnabled();
    fireEvent.click(sendButton());
    await waitFor(() => expect(mocks.enqueue.mutateAsync).toHaveBeenCalledTimes(2));
    const [first, second] = mocks.enqueue.mutateAsync.mock.calls.map(
      (call) => (call[0] as { requestKey: string }).requestKey
    );
    expect(second).not.toBe(first);
  });

  it.each(['FAILED', 'UNCONFIRMED'] as const)(
    'allows only the guarded retry after a %s job',
    async (state) => {
      mocks.enqueue.mutateAsync.mockResolvedValue({
        status: 'QUEUED',
        replayed: false,
        job: jobView({ state, retryable: true, retryRequiresPaperCheck: true }),
      });
      render(<ThermalBridgePanel {...props()} />);
      fireEvent.click(sendButton());
      await screen.findByRole('button', { name: 'Send the same test page again' });
      expect(sendButton()).toBeDisabled();
      fireEvent.click(screen.getByRole('checkbox', { name: /no test page came out/ }));
      expect(sendButton()).toBeDisabled();
      fireEvent.click(sendButton());
      expect(mocks.enqueue.mutateAsync).toHaveBeenCalledTimes(1);
    }
  );

  it('lets a new test page follow an EXPIRED job', async () => {
    mocks.enqueue.mutateAsync.mockResolvedValue({
      status: 'QUEUED',
      replayed: false,
      job: jobView({ state: 'EXPIRED', retryable: true, retryRequiresPaperCheck: false }),
    });
    render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    await screen.findByText('Expired, not sent', { selector: '[data-slot="status-pill"]' });
    expect(sendButton()).toBeEnabled();
  });

  it('after a refused retry, a checked paper box unlocks a new test page', async () => {
    mocks.enqueue.mutateAsync.mockResolvedValue({
      status: 'QUEUED',
      replayed: false,
      job: jobView({ state: 'UNCONFIRMED', retryable: true, retryRequiresPaperCheck: true }),
    });
    mocks.retry.mutateAsync.mockRejectedValue(
      trpcError('PRECONDITION_FAILED', 'The branch’s printer settings changed.')
    );
    render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByRole('checkbox', { name: /no test page came out/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send the same test page again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('printer settings changed');
    expect(sendButton()).toBeEnabled();
  });

  it('stops polling on a status error and offers a manual check', async () => {
    mocks.enqueue.mutateAsync.mockResolvedValue({
      status: 'QUEUED',
      replayed: false,
      job: jobView(),
    });
    const { rerender } = render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    await screen.findByText('Waiting for bridge', { selector: '[data-slot="status-pill"]' });
    const interval = mocks.jobCalls.at(-1)!.opts!.refetchInterval as (q: {
      state: { status?: string; data?: unknown };
    }) => unknown;
    expect(interval({ state: { status: 'error', data: jobView() } })).toBe(false);
    expect(interval({ state: { status: 'success', data: jobView() } })).toBe(2_000);

    mocks.job = query(undefined, { isError: true, error: new TypeError('Failed to fetch') });
    rerender(<ThermalBridgePanel {...props()} />);
    expect(screen.getByRole('status')).toHaveTextContent(/DevFathom stopped checking/);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(mocks.job.refetch).toHaveBeenCalledOnce();
  });

  it('queues one test page for a fast double click', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.enqueue.mutateAsync.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ThermalBridgePanel {...props()} />);
    fireEvent.click(sendButton());
    fireEvent.click(sendButton());
    expect(mocks.enqueue.mutateAsync).toHaveBeenCalledTimes(1);
    resolve({ status: 'FALLBACK', code: 'NO_BRIDGE', fallback: 'BROWSER_OS', message: '' });
    await screen.findByText(PRINT_FALLBACK_TEXT.NO_BRIDGE);
  });

  it('enrolls once for a double submit and never replaces an unshown credential', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.enroll.mutateAsync.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    fireEvent.change(screen.getByLabelText('Bridge name'), { target: { value: 'Till' } });
    fireEvent.change(screen.getByLabelText('Printer target'), {
      target: { value: '/dev/usb/lp0' },
    });
    const enrollButton = screen.getByRole('button', { name: 'Enroll bridge' });
    fireEvent.click(enrollButton);
    fireEvent.click(enrollButton);
    expect(mocks.enroll.mutateAsync).toHaveBeenCalledTimes(1);
    resolve({
      bridge: { ...bridge('bridge-9', 'Till', false), printerId: '/dev/usb/lp0' },
      credential: 'pb_secret_first',
      notice: 'It is not shown again.',
    });
    const heading = await screen.findByRole('heading', {
      name: /Credential for Till — shown once/,
    });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Enroll bridge' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Bridge name'), { target: { value: 'Second' } });
    fireEvent.change(screen.getByLabelText('Printer target'), {
      target: { value: '/dev/usb/lp1' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Enroll bridge' }).closest('form')!);
    expect(mocks.enroll.mutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Bridge credential')).toHaveValue('pb_secret_first');
  });

  it('focuses the first invalid enroll field', async () => {
    mocks.enroll.mutateAsync.mockRejectedValue(
      trpcError('BAD_REQUEST', 'Use tcp://host:9100, queue:///encoded-name, or a /dev/ path.')
    );
    render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    const enrollButton = screen.getByRole('button', { name: 'Enroll bridge' });
    fireEvent.click(enrollButton);
    expect(screen.getByLabelText('Bridge name')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Bridge name'), { target: { value: 'Till' } });
    fireEvent.click(enrollButton);
    expect(screen.getByLabelText('Printer target')).toHaveFocus();
    expect(mocks.enroll.mutateAsync).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Printer target'), { target: { value: 'lp0' } });
    enrollButton.focus();
    fireEvent.click(enrollButton);
    await screen.findByText('Use tcp://host:9100, queue:///encoded-name, or a /dev/ path.');
    expect(screen.getByLabelText('Printer target')).toHaveFocus();
  });

  it('moves focus into the revoke confirm step and back on cancel', () => {
    render(<ThermalBridgePanel {...props({ canEdit: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke…' }));
    expect(screen.getByRole('button', { name: 'Revoke bridge' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Keep bridge' }));
    expect(screen.getByRole('button', { name: 'Revoke…' })).toHaveFocus();
  });
});

it('names no printer brand', () => {
  render(<ThermalBridgePanel {...props({ canEdit: true })} />);
  for (const brand of [/epson/i, /canon/i, /\bstar\b/i, /xprinter/i]) {
    expect(panelText()).not.toMatch(brand);
  }
  const placeholders = Array.from(document.querySelectorAll('[placeholder]'))
    .map((node) => node.getAttribute('placeholder'))
    .join(' ');
  expect(placeholders).not.toMatch(/epson|canon|\bstar\b|xprinter/i);
});
