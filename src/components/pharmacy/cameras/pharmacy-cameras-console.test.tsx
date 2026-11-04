import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  modules: ['pharmacy-core'] as string[],
  workspace: vi.fn(),
  evidence: vi.fn(),
  evidenceReset: vi.fn(),
  invalidate: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  test: vi.fn(),
  register: vi.fn(),
  configure: vi.fn(),
  capture: vi.fn(),
  retention: vi.fn(),
  enroll: vi.fn(),
  liveGrant: vi.fn(),
  diagnose: vi.fn(),
}));
vi.mock('hls.js', () => ({
  default: class {
    static isSupported = () => true;
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'parsed' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    on() {}
    destroy() {}
    loadSource() {}
    attachMedia() {}
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ enabledModules: mocks.modules }),
}));
vi.mock('@/lib/trpc', () => {
  const mutation = (fn: ReturnType<typeof vi.fn>) => ({
    useMutation: () => ({ mutate: fn, mutateAsync: fn, isPending: false }),
  });
  return {
    trpc: {
      useUtils: () => ({
        pharmacyCameras: {
          workspace: { invalidate: mocks.invalidate },
          evidence: { reset: mocks.evidenceReset },
        },
      }),
      pharmacyCameras: {
        workspace: { useQuery: (...args: unknown[]) => mocks.workspace(...args) },
        evidence: { useQuery: (...args: unknown[]) => mocks.evidence(...args) },
        enrollGateway: mutation(mocks.enroll),
        testConnection: mutation(mocks.test),
        register: mutation(mocks.register),
        configure: mutation(mocks.configure),
        setRetention: mutation(mocks.retention),
        issueViewerGrant: mutation(mocks.grant),
        revokeViewerGrant: mutation(mocks.revoke),
        capturePending: mutation(mocks.capture),
        issueLiveViewGrant: mutation(mocks.liveGrant),
        configuredConnectionDiagnostics: {
          useMutation: () => ({
            mutate: mocks.diagnose,
            isPending: false,
            isError: false,
            data: mocks.diagnose.mock.results.at(-1)?.value,
          }),
        },
      },
    },
  };
});

import { PharmacyCamerasConsole } from './pharmacy-cameras-console';

function workspaceData(overrides: Record<string, unknown> = {}) {
  return {
    branches: [{ id: 'branch_a', name: 'Main branch' }],
    gateways: [
      {
        id: 'gw_1',
        name: 'Front gateway',
        branchId: 'branch_a',
        status: 'ACTIVE',
        retentionDays: 7,
      },
    ],
    cameras: [
      {
        id: 'cam_1',
        name: 'Counter camera',
        branchId: 'branch_a',
        gatewayId: 'gw_1',
        sourceRef: 'sim-counter-1',
        enabled: true,
        preset: 'COUNTER',
        temperatureZoneId: null,
        counterEvidence: true,
      },
    ],
    zones: [],
    presets: [],
    availability: { available: true, mode: 'simulated' },
    ...overrides,
  };
}
const ready = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
const idleEvidence = {
  data: undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
};

beforeEach(() => {
  mocks.modules = ['pharmacy-core'];
  for (const fn of Object.values(mocks))
    if (typeof fn === 'function') (fn as ReturnType<typeof vi.fn>).mockReset();
  mocks.workspace.mockReturnValue(ready(workspaceData()));
  mocks.evidence.mockReturnValue(idleEvidence);
  mocks.grant.mockResolvedValue({ id: 'grant_1', expiresAt: new Date() });
});

describe('PharmacyCamerasConsole availability and access', () => {
  it('states the module is unavailable without querying cameras', () => {
    mocks.modules = [];
    render(<PharmacyCamerasConsole />);
    expect(screen.getByRole('status')).toHaveTextContent('not enabled for your organization');
    expect(mocks.workspace).toHaveBeenCalledWith(undefined, { enabled: false, retry: false });
  });

  it('explains owner-only access on a FORBIDDEN read without a retry loop', () => {
    mocks.workspace.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { data: { code: 'FORBIDDEN' } },
      refetch: vi.fn(),
    });
    render(<PharmacyCamerasConsole />);
    expect(screen.getByRole('alert')).toHaveTextContent('pharmacy owners only');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('offers a retry for a non-access load failure', () => {
    const refetch = vi.fn();
    mocks.workspace.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('x'),
      refetch,
    });
    render(<PharmacyCamerasConsole />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('never simulates footage when no gateway is configured', () => {
    mocks.workspace.mockReturnValue(
      ready(workspaceData({ availability: { available: false, mode: 'unavailable' } }))
    );
    render(<PharmacyCamerasConsole />);
    expect(screen.getByText(/No camera footage is being simulated/)).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Register a camera' })).not.toBeInTheDocument();
  });

  it('labels live video and recordings unavailable for every camera', () => {
    render(<PharmacyCamerasConsole />);
    expect(screen.getByText('Live video unavailable. Recordings unavailable.')).toBeVisible();
    expect(screen.queryByText(/Open live view/)).not.toBeInTheDocument();
  });
});

describe('PharmacyCameraWizard callbacks', () => {
  it('offers only the three simulator sources and tests through the callback', async () => {
    mocks.test.mockResolvedValue({ outcome: 'ok', discoveredProfile: 'Diagnostic simulator only' });
    render(<PharmacyCamerasConsole />);
    const form = screen.getByRole('form', { name: 'Register a camera' });
    const source = within(form).getByRole('combobox', { name: /^Simulator source/ });
    expect(
      within(source)
        .getAllByRole('option')
        .map((option) => (option as HTMLOptionElement).value)
    ).toEqual(['sim-camera-1', 'sim-counter-1', 'sim-fridge-1']);
    fireEvent.change(within(form).getByRole('combobox', { name: 'Camera gateway' }), {
      target: { value: 'gw_1' },
    });
    fireEvent.change(within(form).getByLabelText('Camera name'), { target: { value: 'Till' } });
    fireEvent.change(within(form).getByLabelText('Username'), { target: { value: 'placeholder' } });
    fireEvent.change(within(form).getByLabelText('Password'), { target: { value: 'placeholder' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(mocks.test).toHaveBeenCalledWith({ branchId: 'branch_a', sourceRef: 'sim-counter-1' });
    expect(within(form).getByRole('status')).toHaveTextContent(
      'not physical camera or live video proof'
    );
    expect(within(form).getByRole('button', { name: 'Register camera' })).toBeEnabled();
  });
});

describe('PharmacyCamerasConsole presets', () => {
  it('saves COUNTER through configure', () => {
    render(<PharmacyCamerasConsole />);
    const form = screen.getByRole('form', { name: 'Settings for Counter camera' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save camera settings' }));
    expect(mocks.configure).toHaveBeenCalledWith({
      cameraId: 'cam_1',
      preset: 'COUNTER',
      temperatureZoneId: null,
      enabled: true,
    });
  });

  it('blocks a cold-chain preset when the branch has no cold-chain zone', () => {
    render(<PharmacyCamerasConsole />);
    const form = screen.getByRole('form', { name: 'Settings for Counter camera' });
    fireEvent.change(within(form).getByRole('combobox', { name: /^Preset/ }), {
      target: { value: 'COLD_CHAIN' },
    });
    expect(within(form).getByRole('status')).toHaveTextContent('No active cold-chain zone');
    expect(within(form).getByRole('button', { name: 'Save camera settings' })).toBeDisabled();
  });
});

describe('PharmacyCamerasConsole private evidence', () => {
  it('requests a grant, then reads evidence with it', async () => {
    render(<PharmacyCamerasConsole />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open private evidence' }));
    });
    expect(mocks.grant).toHaveBeenCalledWith({ cameraId: 'cam_1' });
    expect(mocks.evidence).toHaveBeenLastCalledWith(
      { cameraId: 'cam_1', grantId: 'grant_1' },
      { enabled: true, retry: false }
    );
  });

  it('shows daily close stills to the owner and revokes on close', async () => {
    mocks.evidence.mockImplementation((input: { grantId: string }) =>
      input.grantId
        ? {
            ...idleEvidence,
            data: [
              {
                id: 'ev_1',
                subjectKind: 'PHARMACY_DAILY_CLOSE',
                subjectId: 'close_1',
                status: 'CAPTURED',
                requestedAt: '2026-10-08T10:00:00.000Z',
                capturedAt: '2026-10-08T10:00:05.000Z',
                failureReason: null,
                image: 'data:image/png;base64,AA==',
              },
            ],
          }
        : idleEvidence
    );
    render(<PharmacyCamerasConsole />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open private evidence' }));
    });
    expect(screen.getByRole('img', { name: /daily close/i })).toHaveAttribute(
      'src',
      'data:image/png;base64,AA=='
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close evidence' }));
    expect(mocks.revoke).toHaveBeenCalledWith({ cameraId: 'cam_1', grantId: 'grant_1' });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(mocks.evidenceReset).toHaveBeenCalled();
  });

  it('clears cached stills when the grant is revoked or expires', async () => {
    let lost = false;
    mocks.evidence.mockImplementation((input: { grantId: string }) =>
      input.grantId && lost
        ? {
            data: [
              {
                id: 'ev_1',
                subjectKind: 'PHARMACY_TENDER',
                status: 'CAPTURED',
                requestedAt: '',
                capturedAt: '',
                image: 'data:image/png;base64,AA==',
              },
            ],
            isLoading: false,
            isError: true,
            isFetching: false,
            error: { data: { code: 'FORBIDDEN' } },
            refetch: vi.fn(),
          }
        : idleEvidence
    );
    const view = render(<PharmacyCamerasConsole />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open private evidence' }));
    });
    mocks.evidenceReset.mockClear();
    lost = true;
    await act(async () => {
      view.rerender(<PharmacyCamerasConsole />);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Viewer access expired or was revoked');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(mocks.evidenceReset).toHaveBeenCalled();
    expect(mocks.evidence).toHaveBeenLastCalledWith(
      { cameraId: '', grantId: '' },
      { enabled: false, retry: false }
    );
  });

  it('reports a refused grant as access lost without reading evidence', async () => {
    mocks.grant.mockRejectedValue(Object.assign(new Error('no'), { data: { code: 'FORBIDDEN' } }));
    render(<PharmacyCamerasConsole />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open private evidence' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Viewer access expired or was revoked');
    expect(mocks.evidence).not.toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'grant_1' }),
      expect.anything()
    );
  });
});

it('camera evidence drops its grant and cache when workspace access is lost', async () => {
  const view = render(<PharmacyCamerasConsole />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open private evidence' }));
  });
  mocks.evidenceReset.mockClear();
  mocks.workspace.mockReturnValue({
    data: workspaceData(),
    isLoading: false,
    isError: true,
    error: { data: { code: 'FORBIDDEN' } },
    refetch: vi.fn(),
  });
  await act(async () => {
    view.rerender(<PharmacyCamerasConsole />);
  });
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(mocks.evidenceReset).toHaveBeenCalled();
  expect(mocks.evidence).toHaveBeenLastCalledWith(
    { cameraId: '', grantId: '' },
    { enabled: false, retry: false }
  );
});

it('submits retention through the visible save button with the exact branch and days', () => {
  render(<PharmacyCamerasConsole />);
  const form = screen.getByRole('form', { name: 'Retention for Main branch' });
  fireEvent.change(within(form).getByLabelText('Retention days'), { target: { value: '1' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Save retention' }));
  expect(mocks.retention).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch_a', days: 1 });
});

describe('PharmacyCamerasConsole configured gateway (DEV-740)', () => {
  const configured = (cameraOverrides: Record<string, unknown> = {}) =>
    workspaceData({
      availability: { available: true, mode: 'mediamtx' },
      cameras: [
        {
          id: 'cam_1',
          name: 'Counter camera',
          branchId: 'branch_a',
          gatewayId: 'gw_1',
          sourceRef: 'counter-1',
          enabled: true,
          preset: 'COUNTER',
          temperatureZoneId: null,
          counterEvidence: true,
          ...cameraOverrides,
        },
      ],
    });

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    mocks.liveGrant.mockResolvedValue({
      grantId: 'live_1',
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it('offers configured setup without simulator sources or credential fields', () => {
    mocks.workspace.mockReturnValue(ready(configured()));
    render(<PharmacyCamerasConsole />);
    expect(screen.getByRole('form', { name: 'Register a configured gateway' })).toBeVisible();
    const cameraForm = screen.getByRole('form', { name: 'Register a configured camera' });
    expect(within(cameraForm).getByLabelText('Gateway stream path')).toBeVisible();
    expect(within(cameraForm).queryByLabelText('Password')).not.toBeInTheDocument();
    expect(within(cameraForm).queryByLabelText('Username')).not.toBeInTheDocument();
    expect(screen.queryByText(/Simulator source/)).not.toBeInTheDocument();
    expect(
      screen.queryByText('Live video unavailable. Recordings unavailable.')
    ).not.toBeInTheDocument();
  });

  it('registers a configured gateway with its exact URL', async () => {
    mocks.workspace.mockReturnValue(ready(configured()));
    mocks.enroll.mockResolvedValue({ id: 'gw_2' });
    render(<PharmacyCamerasConsole />);
    const form = screen.getByRole('form', { name: 'Register a configured gateway' });
    fireEvent.change(within(form).getByLabelText('Gateway name'), { target: { value: 'Main' } });
    fireEvent.change(within(form).getByLabelText(/Gateway URL/), {
      target: { value: 'https://camera-gateway.example.internal/' },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(mocks.enroll).toHaveBeenCalledWith({
      branchId: 'branch_a',
      name: 'Main',
      baseUrl: 'https://camera-gateway.example.internal/',
      retentionDays: 7,
    });
  });

  it('registers a configured camera without credentials', async () => {
    mocks.workspace.mockReturnValue(ready(configured()));
    mocks.register.mockResolvedValue({ id: 'cam_2' });
    render(<PharmacyCamerasConsole />);
    const form = screen.getByRole('form', { name: 'Register a configured camera' });
    fireEvent.change(within(form).getByLabelText('Camera name'), { target: { value: 'Fridge' } });
    fireEvent.change(within(form).getByLabelText('Camera gateway'), { target: { value: 'gw_1' } });
    fireEvent.change(within(form).getByLabelText('Gateway stream path'), {
      target: { value: 'fridge-1' },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(mocks.register).toHaveBeenCalledWith({
      branchId: 'branch_a',
      gatewayId: 'gw_1',
      name: 'Fridge',
      sourceRef: 'fridge-1',
      registerAnyway: false,
    });
    expect(within(form).getByRole('status')).toHaveTextContent('registered disabled');
  });

  it('shows binding IDs, runs the configured check and states snapshot capture is unsupported', () => {
    mocks.workspace.mockReturnValue(ready(configured()));
    mocks.diagnose.mockReturnValue({ outcome: 'ok' });
    render(<PharmacyCamerasConsole />);
    expect(screen.getByText('cam_1')).toBeVisible();
    expect(screen.getByText('gw_1')).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent('not supported by this live gateway');
    fireEvent.click(screen.getByRole('button', { name: 'Check configured connection' }));
    expect(mocks.diagnose).toHaveBeenCalledWith({ cameraId: 'cam_1' });
  });

  it('opens live view on the pharmacy endpoint and releases the grant on close', async () => {
    mocks.workspace.mockReturnValue(ready(configured()));
    render(<PharmacyCamerasConsole />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open live view' }));
    });
    expect(mocks.liveGrant).toHaveBeenCalledWith({ cameraId: 'cam_1', previousGrantId: undefined });
    const video = screen.getByLabelText('Counter camera playback panel');
    expect(video).toHaveAttribute('src', '/api/pharmacy/cameras/cam_1/stream?grant=live_1');
    expect(video.getAttribute('src')).not.toMatch(/https?:|rtsp:|@/);
    fireEvent.click(screen.getByRole('button', { name: 'Close live view' }));
    expect(mocks.revoke).toHaveBeenCalledWith({ cameraId: 'cam_1', grantId: 'live_1' });
    expect(screen.queryByLabelText('Counter camera playback panel')).not.toBeInTheDocument();
  });

  it('keeps a disabled camera out of live view', () => {
    mocks.workspace.mockReturnValue(ready(configured({ enabled: false })));
    render(<PharmacyCamerasConsole />);
    expect(screen.getByRole('button', { name: 'Open live view' })).toBeDisabled();
    expect(screen.getByText(/Enable after the configured connection check passes/)).toBeVisible();
    expect(mocks.liveGrant).not.toHaveBeenCalled();
  });
});
