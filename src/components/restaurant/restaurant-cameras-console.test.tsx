import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { RestaurantCamerasConsole } from './restaurant-cameras-console';

const query = vi.fn();
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
      list: { useQuery: vi.fn(() => ({ data: [] })) },
      listGateways: { useQuery: vi.fn(() => ({ data: [] })) },
      listRecordings: { useQuery: vi.fn(() => ({ data: [] })) },
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
    expect(source).toContain('Play in panel');
    expect(source).toContain('Save retention');
    expect(source.match(/<RestaurantCameraWizard/g)).toHaveLength(1);
    expect(source).toContain('onTest={onTest}');
    expect(source).toContain('onSubmit={onSubmit}');
  });
});
