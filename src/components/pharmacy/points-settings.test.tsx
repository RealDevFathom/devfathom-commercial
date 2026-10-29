import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PointsSettings } from './points-settings';
const mocks = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  mutation: {} as Record<string, unknown>,
  save: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      pointsPolicy: { useQuery: () => mocks.query },
      savePointsPolicy: { useMutation: () => ({ ...mocks.mutation, mutateAsync: mocks.save }) },
    },
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query = {
    data: {
      pointsEnabled: true,
      earnEveryMinor: 1000,
      pointValueMinor: 100,
      minimumRedeemPoints: 5,
    },
    refetch: mocks.refetch,
  };
  mocks.mutation = {};
});
it('keeps an explicit loading and permission state', () => {
  mocks.query = { isLoading: true };
  const { rerender } = render(<PointsSettings />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading policy');
  mocks.query = { isError: true, refetch: mocks.refetch };
  rerender(<PointsSettings />);
  expect(screen.getByRole('alert')).toHaveTextContent('Owner or administrator');
  expect(screen.queryByRole('button', { name: 'Save loyalty settings' })).not.toBeInTheDocument();
});
it('submits configured integer rates and opt-in programme state', async () => {
  mocks.save.mockResolvedValue({});
  render(<PointsSettings />);
  fireEvent.change(screen.getByLabelText('Spend per earned point (paisa)'), {
    target: { value: '2500' },
  });
  fireEvent.click(screen.getByLabelText('Enable earning and redemption'));
  fireEvent.click(screen.getByRole('button', { name: 'Save loyalty settings' }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      pointsEnabled: false,
      earnEveryMinor: 2500,
      pointValueMinor: 100,
      minimumRedeemPoints: 5,
    })
  );
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('saved'));
});
it('preserves entered settings when save fails and shows the error', async () => {
  mocks.save.mockRejectedValue(new Error('Denied'));
  mocks.mutation = { isError: true, error: { message: 'Denied' } };
  render(<PointsSettings />);
  fireEvent.change(screen.getByLabelText('Minimum points per redemption'), {
    target: { value: '20' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save loyalty settings' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(screen.getByLabelText('Minimum points per redemption')).toHaveValue(20);
  expect(screen.getByRole('alert')).toHaveTextContent('Denied');
});
