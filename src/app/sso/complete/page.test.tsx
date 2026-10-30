import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  router: { replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock('next-auth/react', () => ({ signIn: mocks.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
import Page from './page';

afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

it('exchanges the enterprise ticket before navigating to the fresh-login landing', async () => {
  let resolve!: (value: unknown) => void;
  mocks.signIn.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  render(<Page />);
  expect(screen.getByText('Opening your workspace')).toBeVisible();
  expect(mocks.signIn).toHaveBeenCalledWith('enterprise', { redirect: false });
  expect(mocks.router.replace).not.toHaveBeenCalled();
  await act(async () => resolve({ error: null, ok: true }));
  expect(mocks.router.replace).toHaveBeenCalledExactlyOnceWith('/dashboard?landing=1');
  expect(mocks.router.refresh).toHaveBeenCalledOnce();
});

it.each(['error', 'missing', 'rejected'])(
  'shows a recoverable failure for %s without navigation',
  async (failure) => {
    if (failure === 'rejected') mocks.signIn.mockRejectedValue(new Error('network'));
    else mocks.signIn.mockResolvedValue(failure === 'missing' ? undefined : { error: 'expired' });
    render(<Page />);
    expect(await screen.findByText('Sign-in could not finish')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Return to sign in' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  }
);

it.each([false, true])(
  'ignores a ticket response after unmount (rejection: %s)',
  async (reject) => {
    let settle!: () => void;
    mocks.signIn.mockReturnValue(
      new Promise((resolve, fail) => {
        settle = () => (reject ? fail(new Error('network')) : resolve({ error: null }));
      })
    );
    const view = render(<Page />);
    view.unmount();
    await act(async () => settle());
    await waitFor(() => expect(mocks.router.replace).not.toHaveBeenCalled());
    expect(mocks.router.refresh).not.toHaveBeenCalled();
  }
);
