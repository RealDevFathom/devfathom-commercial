import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { RestaurantCamerasConsole } from './restaurant-cameras-console';

const query = vi.fn();
const cameraQuery = vi.fn(() => ({ data: [] as { id: string; name: string; enabled: boolean }[] }));
const diagnosticQuery = vi.fn();
const recordingQuery = vi.fn(() => ({ data: [] }));
const source = readFileSync('src/components/restaurant/restaurant-cameras-console.tsx', 'utf8');

vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ enabledModules: ['restaurant-integrations'] }),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      restaurantCameras: { list: { invalidate: vi.fn() }, listGateways: { invalidate: vi.fn() } },
    }),
    restaurantCameras: {
      availability: { useQuery: (...args: unknown[]) => query(...args) },
      presets: { useQuery: vi.fn(() => ({ data: [] })) },
      list: { useQuery: (...args: unknown[]) => cameraQuery(...(args as [])) },
      listGateways: { useQuery: vi.fn(() => ({ data: [] })) },
      listRecordings: { useQuery: (...args: unknown[]) => recordingQuery(...(args as [])) },
      configuredConnectionDiagnostics: {
        useQuery: (...args: unknown[]) => diagnosticQuery(...args),
      },
      testConnection: { useMutation: vi.fn(() => ({ isPending: false })) },
      register: { useMutation: vi.fn(() => ({ isPending: false })) },
      issueStreamGrant: { useMutation: vi.fn(() => ({ isPending: false })) },
      setRetention: { useMutation: vi.fn(() => ({ isPending: false })) },
    },
    restaurantStaff: { list: { useQuery: vi.fn(() => ({ data: [] })) } },
  },
}));

describe('RestaurantCamerasConsole gateway availability', () => {
  beforeEach(() => query.mockReturnValue({ data: undefined, isLoading: false, isError: false }));

  test('renders an accessible not-configured state without feeds or recordings', () => {
    render(<RestaurantCamerasConsole />);

    expect(screen.getByRole('heading', { name: 'Camera gateway not configured' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('No camera footage is being simulated.');
    expect(screen.queryByText('Ready for live view')).not.toBeInTheDocument();
    expect(screen.queryByText('Gateway recordings')).not.toBeInTheDocument();
  });

  test('renders a status while availability is loading', () => {
    query.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<RestaurantCamerasConsole />);

    expect(screen.getByRole('status')).toHaveTextContent('Checking whether camera services');
  });

  test('preserves the existing camera controls behind the availability gate', () => {
    expect(source).toContain("includes('restaurant-integrations')");
    expect(source).toContain('Open live view');
    expect(source).toContain('Recording playback unsupported');
    expect(source).toContain('Save retention');
    expect(source.match(/<RestaurantCameraWizard/g)).toHaveLength(1);
    expect(source).toContain('onTest={onTest}');
    expect(source).toContain('onSubmit={onSubmit}');
  });
  test('an H.265 camera check says which browsers play it', () => {
    query.mockReturnValue({ data: { available: true, mode: 'mediamtx' } });
    cameraQuery.mockReturnValue({ data: [{ id: 'c', name: 'Kitchen', enabled: true }] });
    diagnosticQuery.mockReturnValue({
      data: { outcome: 'ok', discoveredProfile: 'Configured HLS gateway', videoCodec: 'h265' },
      refetch: vi.fn(),
    });
    render(<RestaurantCamerasConsole />);
    expect(screen.getByText(/This camera sends H\.265 \(HEVC\) video/)).toBeVisible();
    expect(screen.getByText(/Chrome and Edge play it only on computers with H\.265/)).toBeVisible();
  });

  test('real-mode diagnostics are explicit, manual and never load recordings', () => {
    query.mockReturnValue({ data: { available: true, mode: 'mediamtx' } });
    cameraQuery.mockReturnValue({ data: [{ id: 'c', name: 'Kitchen', enabled: true }] });
    const refetch = vi.fn();
    diagnosticQuery.mockReturnValue({ data: { outcome: 'credentials-missing' }, refetch });
    render(<RestaurantCamerasConsole />);
    expect(screen.getByText(/Recordings unsupported by this live gateway/)).toBeVisible();
    expect(screen.getByText(/Gateway reader credentials are missing/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Check configured connection' }));
    expect(refetch).toHaveBeenCalledOnce();
    expect(diagnosticQuery).toHaveBeenCalledWith(
      { cameraId: 'c' },
      { enabled: false, retry: false }
    );
    expect(recordingQuery).toHaveBeenLastCalledWith(
      { cameraId: '' },
      { enabled: false, retry: false }
    );
  });
});
