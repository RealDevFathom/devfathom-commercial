import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  role: 'ADMIN',
  loading: false,
  error: null as Error | null,
  closeError: null as Error | null,
  mutate: vi.fn(),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: 'authenticated',
    data: {
      user: {
        id: 'owner',
        role: mocks.role,
        organizationId: 'org',
        status: 'ACTIVE',
        sessionRevoked: false,
      },
    },
  }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ organizationId: 'org', enabledModules: ['pharmacy-counter'] }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      counterBranches: {
        useQuery: () => ({ data: { branches: [{ id: 'b', name: 'Main' }] }, isSuccess: true }),
      },
      closePreview: {
        useQuery: () => ({
          isLoading: mocks.loading,
          error: mocks.error,
          refetch: vi.fn(),
          data: {
            branchName: 'Main',
            close: null,
            totals: { cashExpectedMinor: 12500, sourceHash: 'hash' },
            drawers: [
              {
                id: 'd',
                deviceId: 'counter-0f3b9a5e-6c2d-4f1e-9a7b-2c4d6e8f0a1b',
                status: 'OPEN',
                openedAt: new Date('2026-09-29T04:12:00Z'),
                openedBy: 'Ayesha Karim',
                expectedMinor: 12500,
                countedMinor: null,
              },
            ],
          },
        }),
      },
      closeDay: {
        useMutation: () => ({
          mutate: mocks.mutate,
          reset: vi.fn(),
          error: mocks.closeError,
          data: undefined,
          isPending: false,
        }),
      },
    },
  },
}));
import { cashMinor, drawerOpenedLabel, PharmacyDayCloseConsole } from './day-close-console';
afterEach(cleanup);
beforeEach(() => {
  mocks.role = 'ADMIN';
  mocks.loading = false;
  mocks.error = null;
  mocks.closeError = null;
  mocks.mutate.mockReset();
});
describe('day-close console', () => {
  it('parses exact cash minor units without rounding an invalid amount', () => {
    expect(cashMinor('125.01')).toBe(12501);
    expect(cashMinor('0')).toBe(0);
    for (const bad of ['', '-1', '1.001', '1e3', '21474836.48']) expect(cashMinor(bad)).toBeNull();
  });
  it('labels a drawer by its opener and time, never by the device identifier', () => {
    render(<PharmacyDayCloseConsole />);
    const label = screen.getByText(/^Drawer 1 ·/);
    expect(label).toHaveTextContent(/Drawer 1 · Opened \d{2}:\d{2} by Ayesha Karim · Open/);
    expect(label).not.toHaveTextContent(/counter-0f3b9a5e/);
    expect(drawerOpenedLabel({ openedAt: '2026-09-29T04:12:00Z', openedBy: null })).toMatch(
      /^Opened \d{2}:\d{2}$/
    );
  });
  it('shows permission denial for a non-administrator', () => {
    mocks.role = 'MEMBER';
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByText(/Sign in as a pharmacy administrator/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close and lock day' })).not.toBeInTheDocument();
  });
  it('shows loading and retryable errors', () => {
    mocks.loading = true;
    const view = render(<PharmacyDayCloseConsole />);
    expect(screen.getByText(/Loading cash movements/)).toBeInTheDocument();
    mocks.loading = false;
    mocks.error = new Error('Network unavailable');
    view.rerender(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable');
    expect(screen.getByRole('button', { name: 'Retry preview' })).toBeInTheDocument();
  });
  it('requires a count, variance note and explicit confirmation before submitting', () => {
    render(<PharmacyDayCloseConsole />);
    const submit = screen.getByRole('button', { name: 'Close and lock day' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Counted cash for drawer 1 (PKR)'), {
      target: { value: '124.00' },
    });
    expect(screen.getByTestId('Variance')).toHaveTextContent('-1.00');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Variance note/), {
      target: { value: 'Short by one rupee' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        counts: [{ drawerSessionId: 'd', countedCashMinor: 12400 }],
        varianceNote: 'Short by one rupee',
      })
    );
  });
  it('shows the friendly close error supplied by the router', () => {
    mocks.closeError = new Error(
      'The day could not be closed safely. Refresh the preview and try again. If it still fails, ask a supervisor.'
    );
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('alert')).toHaveTextContent('The day could not be closed safely.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('append-only');
  });
});
