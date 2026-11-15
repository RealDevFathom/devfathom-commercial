import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CounterSignOut } from './counter-sign-out';

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('@/lib/auth/sign-out', () => ({ signOutEverything: signOut }));
beforeEach(() => signOut.mockReset());

it('prevents duplicate sign-out while showing progress', async () => {
  let finish!: () => void;
  signOut.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    })
  );
  render(<CounterSignOut hasOpenSale={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  const button = screen.getByRole('button', { name: 'Signing out…' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(signOut).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});

it.each([false, true])('allows retry after sign-out fails (open sale: %s)', async (hasOpenSale) => {
  signOut.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
  render(<CounterSignOut hasOpenSale={hasOpenSale} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  if (hasOpenSale)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Sign-out failed. Please try again.');
  const scope = hasOpenSale ? within(screen.getByRole('dialog')) : screen;
  expect(scope.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  fireEvent.click(scope.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
