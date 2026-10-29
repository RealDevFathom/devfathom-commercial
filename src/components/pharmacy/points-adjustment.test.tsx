import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PointsAdjustment } from './points-adjustment';
const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      adjustPoints: { useMutation: () => ({ mutateAsync: mocks.save, isPending: false }) },
    },
  },
}));
beforeEach(() => {
  mocks.save.mockReset().mockImplementation(() => new Promise(() => {}));
});
it('requires explicit confirmation for a negative correction and Escape cancels', () => {
  render(<PointsAdjustment branchId="branch" customerId="customer" saleId="sale" />);
  fireEvent.change(screen.getByLabelText('Points to add or remove'), { target: { value: '-5' } });
  fireEvent.change(screen.getByLabelText('Adjustment reason'), {
    target: { value: 'Duplicate award correction' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Record points correction' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Remove 5 points?');
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm points removal' }), {
    key: 'Escape',
  });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Record points correction' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm points removal' }));
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({
      points: -5,
      reason: 'Duplicate award correction',
      branchId: 'branch',
      customerId: 'customer',
      saleId: 'sale',
    })
  );
});
