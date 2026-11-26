import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QualityReview } from './supervision';

const mocks = vi.hoisted(() => ({ canDecide: false, submit: vi.fn(), invalidate: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyWarehouse: { invalidate: mocks.invalidate },
      pharmacyInventory: { transferBoard: { invalidate: mocks.invalidate } },
      pharmacyMedicine: { catalogueEdits: { invalidate: mocks.invalidate } },
    }),
    pharmacyMedicine: {
      catalogueQueueAccess: { useQuery: () => ({ data: { canDecide: mocks.canDecide } }) },
    },
    pharmacyWarehouse: {
      quality: { useQuery: () => ({ data: [] }) },
      reviewQuality: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      searchMedicines: {
        useQuery: ({ query }: { query: string }) => ({
          data: query
            ? [
                {
                  id: 'cold-item',
                  productName: 'Cold chain test medicine',
                  coldChain: true,
                  minimumStorageTemperatureC: 2,
                  maximumStorageTemperatureC: 8,
                },
              ]
            : undefined,
        }),
      },
      proposeProductTemperatures: { useMutation: () => ({ mutateAsync: mocks.submit }) },
    },
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([true, false])(
  'records a proposal and offers the review route only when authorized (reviewer %s)',
  async (canDecide) => {
    mocks.canDecide = canDecide;
    mocks.submit.mockResolvedValue({
      medicineId: 'cold-item',
      proposalId: 'review-123',
      status: 'PENDING',
    });
    render(<QualityReview branchId="central" canReview />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Find a cold-chain medicine' }), {
      target: { value: 'cold' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Proposed maximum °C' }), {
      target: { value: '6' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit temperature range for review' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Temperature proposal submitted for catalogue review.'
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'central',
        medicineId: 'cold-item',
        minimumC: 2,
        maximumC: 6,
      })
    );
    expect(screen.getByText(/approved storage range/i)).toHaveTextContent('2 °C to 8 °C');
    const link = screen.queryByRole('link', {
      name: 'Open submitted proposal in catalogue review',
    });
    if (canDecide)
      expect(link).toHaveAttribute('href', '/pharmacy/medicines#catalogue-edit-review-123');
    else expect(link).not.toBeInTheDocument();
  }
);
