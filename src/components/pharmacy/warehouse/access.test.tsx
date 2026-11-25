import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WarehouseWorkspace } from './workspace';

const api = vi.hoisted(() => ({
  sites: vi.fn(),
  setup: vi.fn(),
  overview: vi.fn(),
  quality: vi.fn(),
  outbound: vi.fn(),
  requests: vi.fn(),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { role: 'EMPLOYEE' } } }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyWarehouse: {
      sites: { useQuery: api.sites },
      setup: { useQuery: api.setup },
      overview: { useQuery: api.overview },
      quality: { useQuery: api.quality },
      outbound: { useQuery: api.outbound },
      requestQueue: { useQuery: api.requests },
      reviewQuality: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      searchMedicines: { useQuery: () => ({}) },
      proposeProductTemperatures: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    pharmacyMedicine: {
      catalogueQueueAccess: { useQuery: () => ({ data: { canDecide: false } }) },
    },
    useUtils: () => ({}),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('opens only assigned quality work and never reads operational queues for a safety-only reviewer', () => {
  api.sites.mockReturnValue({
    data: [{ id: 'assigned', name: 'Assigned branch', accessMode: 'quality' }],
  });
  api.quality.mockReturnValue({
    data: [
      {
        id: 'hold',
        productName: 'Cold medicine',
        quantityUnits: 2,
        status: 'DISPOSE',
        binCode: 'FR',
        batchNumber: '007',
        reason: 'Excursion',
      },
    ],
  });
  render(<WarehouseWorkspace initialBranchId="not-assigned" />);
  expect(api.quality).toHaveBeenCalledWith({ branchId: 'assigned' });
  expect(screen.getByRole('heading', { name: 'Quality review queue' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Labelled product temperatures' })).toBeVisible();
  expect(screen.queryByRole('navigation', { name: 'Warehouse workflows' })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('link', { name: /write-off|supplier returns/i })
  ).not.toBeInTheDocument();
  expect(api.setup).not.toHaveBeenCalled();
  expect(api.overview).not.toHaveBeenCalled();
  expect(api.outbound).not.toHaveBeenCalled();
  expect(api.requests).not.toHaveBeenCalled();
});

it('keeps warehouse workflow navigation for an inventory operator and owner configuration when granted', () => {
  api.sites.mockReturnValue({
    data: [{ id: 'central', name: 'Central', warehouseEnabled: true, accessMode: 'inventory' }],
  });
  api.setup.mockReturnValue({ data: { enabled: true, canReview: true, canConfigure: true } });
  api.overview.mockReturnValue({ data: undefined });
  render(<WarehouseWorkspace />);
  expect(api.setup).toHaveBeenCalledWith({ branchId: 'central' });
  expect(api.overview).toHaveBeenCalledWith({ branchId: 'central' });
  expect(screen.getByRole('navigation', { name: 'Warehouse workflows' })).toBeVisible();
  for (const label of ['Overview', 'Requests', 'Pick and pack', 'Arrivals', 'Quality', 'Setup']) {
    expect(screen.getByRole('button', { name: label })).toBeVisible();
  }
});
