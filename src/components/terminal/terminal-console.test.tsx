import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TerminalConsole } from './terminal-console';

type Handler = (body: Record<string, string>) => Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createTransport() {
  const transport: {
    actor: string | null;
    heartbeat?: Handler;
    lock?: Handler;
    switchOperator?: Handler;
    fetch: ReturnType<typeof vi.fn>;
  } = {
    actor: null,
    fetch: vi.fn(),
  };

  transport.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};

    if (path.endsWith('/establish')) {
      return json(
        {
          sessionToken: 'rts_test',
          session: { id: 'session-1', state: 'LOCKED', establishedAt: '2026-08-18T00:00:00Z' },
          device: { id: 'device-1', branchId: 'branch-1' },
        },
        201
      );
    }
    if (path.endsWith('/operators')) {
      return json({
        operators: [
          { staffProfileId: 'staff-a', displayName: 'Amina Khan', role: 'Cashier' },
          { staffProfileId: 'staff-b', displayName: 'Bilal Shah', role: 'Supervisor' },
          { staffProfileId: 'manager-a', displayName: 'Mina Ali', role: 'Manager' },
        ],
      });
    }
    if (path.endsWith('/unlock')) {
      transport.actor = body.staffProfileId;
      return json({
        session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: transport.actor },
      });
    }
    if (path.endsWith('/switch')) {
      if (transport.switchOperator) return transport.switchOperator(body);
      transport.actor = body.staffProfileId;
      return json({
        session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: transport.actor },
      });
    }
    if (path.endsWith('/lock')) {
      if (transport.lock) return transport.lock(body);
      transport.actor = null;
      return json({
        session: { id: 'session-1', state: 'LOCKED', activeStaffProfileId: null },
      });
    }
    if (path.endsWith('/heartbeat')) {
      if (transport.heartbeat) return transport.heartbeat(body);
      return json({
        session: {
          id: 'session-1',
          state: transport.actor ? 'UNLOCKED' : 'LOCKED',
          activeStaffProfileId: transport.actor,
        },
        device: { id: 'device-1', health: 'HEALTHY' },
        serverTime: '2026-08-18T00:01:00Z',
      });
    }
    if (path.endsWith('/co-authorize')) {
      return json({
        coAuthorization: {
          id: 'approval-1',
          capability: body.capability,
          actingStaffProfileId: transport.actor,
          approvingStaffProfileId: body.approvingStaffProfileId,
          targetType: null,
          targetId: null,
          createdAt: '2026-08-18T00:02:00Z',
        },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  return transport;
}

async function enroll() {
  render(<TerminalConsole />);
  const submit = screen.getByRole('button', { name: 'Establish locked session' });
  expect(submit).toHaveAttribute('type', 'submit');
  fireEvent.change(screen.getByLabelText('One-time enrollment secret'), {
    target: { value: 'rde_test' },
  });
  fireEvent.click(submit);
  await screen.findByRole('heading', { name: 'Unlock terminal' });
  await waitFor(() => expect(screen.getByLabelText('Operator')).toBeEnabled());
}

async function unlock(operator = 'staff-a') {
  fireEvent.change(screen.getByLabelText('Operator'), {
    target: { value: operator },
  });
  fireEvent.change(screen.getByLabelText('Operator PIN'), { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify and unlock' }));
  await screen.findByRole('button', { name: 'Lock terminal' });
}

function callsTo(fetch: ReturnType<typeof vi.fn>, suffix: string) {
  return fetch.mock.calls.filter(([input]) => String(input).endsWith(suffix)).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('terminal console transitions', () => {
  it('marks form actions as submits and clears every credential input on lock', async () => {
    const transport = createTransport();
    vi.stubGlobal('fetch', transport.fetch);
    await enroll();
    expect(screen.getByRole('button', { name: 'Verify and unlock' })).toHaveAttribute(
      'type',
      'submit'
    );
    await unlock();
    expect(screen.getByRole('button', { name: 'Verify incoming operator' })).toHaveAttribute(
      'type',
      'submit'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Manager approval' }));
    expect(screen.getByRole('button', { name: 'Verify and record approval' })).toHaveAttribute(
      'type',
      'submit'
    );
    fireEvent.change(screen.getByLabelText('Approving manager'), {
      target: { value: 'manager-a' },
    });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch operator' }));
    fireEvent.change(screen.getByLabelText('Incoming operator'), {
      target: { value: 'staff-b' },
    });
    fireEvent.change(screen.getByLabelText('Incoming operator PIN'), {
      target: { value: '8765' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Lock terminal' }));
    await screen.findByRole('heading', { name: 'Unlock terminal' });
    expect(screen.getByLabelText('Operator')).toHaveValue('');
    expect(screen.getByLabelText('Operator PIN')).toHaveValue('');

    await unlock();
    fireEvent.click(screen.getByRole('button', { name: 'Manager approval' }));
    expect(screen.getByLabelText('Approving manager')).toHaveValue('');
    expect(screen.getByLabelText('Manager PIN')).toHaveValue('');
  });

  it('keeps lock available during heartbeat and ignores its stale completion', async () => {
    const transport = createTransport();
    vi.stubGlobal('fetch', transport.fetch);
    await enroll();
    await unlock();

    const heartbeat = deferred<Response>();
    const lock = deferred<Response>();
    transport.heartbeat = async () => heartbeat.promise;
    transport.lock = async () => lock.promise;

    fireEvent.click(screen.getByRole('button', { name: 'Check server status' }));
    await waitFor(() => expect(callsTo(transport.fetch, '/heartbeat')).toBe(1));
    const lockButton = screen.getByRole('button', { name: 'Lock terminal' });
    expect(lockButton).toBeEnabled();

    fireEvent.click(lockButton);
    await waitFor(() => expect(callsTo(transport.fetch, '/lock')).toBe(1));
    expect(lockButton).toBeDisabled();
    fireEvent.click(lockButton);
    expect(callsTo(transport.fetch, '/lock')).toBe(1);

    transport.actor = null;
    await act(async () => {
      lock.resolve(
        json({ session: { id: 'session-1', state: 'LOCKED', activeStaffProfileId: null } })
      );
    });
    await screen.findByRole('heading', { name: 'Unlock terminal' });

    await act(async () => {
      heartbeat.resolve(
        json({
          session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: 'staff-a' },
          device: { id: 'device-1', health: 'HEALTHY' },
          serverTime: '2026-08-18T00:03:00Z',
        })
      );
    });
    expect(screen.getByRole('heading', { name: 'Unlock terminal' })).toBeInTheDocument();
  });

  it('renders manager approval evidence with friendly names and no internal IDs', async () => {
    const transport = createTransport();
    vi.stubGlobal('fetch', transport.fetch);
    await enroll();
    await unlock();

    fireEvent.click(screen.getByRole('button', { name: 'Manager approval' }));
    expect(screen.queryByLabelText('Target ID (optional)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Target type (optional)')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Approving manager'), {
      target: { value: 'manager-a' },
    });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '5678' } });
    fireEvent.change(screen.getByLabelText('Capability / action'), {
      target: { value: 'orders:void' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Guest rejected item' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and record approval' }));

    await screen.findByRole('heading', { name: 'Last manager approval' });
    expect(screen.getAllByText('Amina Khan').length).toBeGreaterThan(0);
    expect(screen.getByText('Mina Ali')).toBeVisible();
    for (const internalId of ['staff-a', 'manager-a', 'approval-1', 'device-1', 'session-1']) {
      expect(screen.queryByText(internalId, { exact: true })).not.toBeInTheDocument();
    }
  });

  it('clears handoff credentials and reconciles an ambiguous switch from heartbeat', async () => {
    const transport = createTransport();
    vi.stubGlobal('fetch', transport.fetch);
    await enroll();
    await unlock();

    fireEvent.click(screen.getByRole('button', { name: 'Manager approval' }));
    fireEvent.change(screen.getByLabelText('Approving manager'), {
      target: { value: 'manager-a' },
    });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch operator' }));
    fireEvent.change(screen.getByLabelText('Incoming operator'), {
      target: { value: 'staff-b' },
    });
    fireEvent.change(screen.getByLabelText('Incoming operator PIN'), {
      target: { value: '8765' },
    });
    transport.switchOperator = async () => {
      throw new TypeError('response lost');
    };

    fireEvent.click(screen.getByRole('button', { name: 'Verify incoming operator' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Verify incoming operator' })).toBeEnabled()
    );
    expect(callsTo(transport.fetch, '/heartbeat')).toBe(1);
    expect(screen.getByText('Acting operator').parentElement).toHaveTextContent(
      'Amina Khan — Cashier'
    );
    expect(screen.queryByText('Connection degraded')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Incoming operator')).toHaveValue('');
    expect(screen.getByLabelText('Incoming operator PIN')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Manager approval' }));
    expect(screen.getByLabelText('Approving manager')).toHaveValue('');
    expect(screen.getByLabelText('Manager PIN')).toHaveValue('');
  });

  it('clears recovered heartbeat failures without replacing unrelated notices', async () => {
    const transport = createTransport();
    vi.stubGlobal('fetch', transport.fetch);
    await enroll();
    await unlock();

    fireEvent.click(screen.getByRole('button', { name: 'Check server status' }));
    await waitFor(() => expect(callsTo(transport.fetch, '/heartbeat')).toBe(1));
    expect(screen.getByText('Terminal unlocked')).toBeInTheDocument();

    transport.heartbeat = async () => {
      throw new TypeError('offline');
    };
    fireEvent.click(screen.getByRole('button', { name: 'Check server status' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection degraded');

    transport.heartbeat = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Check server status' }));
    await waitFor(() => expect(screen.queryByText('Connection degraded')).not.toBeInTheDocument());
    expect(screen.getByText('Server status refreshed')).toBeInTheDocument();
  });
});
