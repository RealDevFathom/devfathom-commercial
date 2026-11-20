import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-931: the "Your PIN" screen. The server enforces every rule; the screen explains them,
// sends the password with the PIN, and never shows the PIN back.
type Status = {
  state: 'SET' | 'NOT_SET' | 'RESET';
  locked: boolean;
  supportSession: boolean;
  canResetOthers: boolean;
};
const mocks = vi.hoisted(() => ({
  status: {
    data: undefined as Status | undefined,
    isLoading: false,
    isError: false,
  },
  members: {
    data: [] as Array<{ id: string; name: string; hasPin: boolean; canReset: boolean }>,
    isLoading: false,
    isError: false,
  },
  setMine: vi.fn(),
  reset: vi.fn(),
  callbacks: {} as Record<
    string,
    { onSuccess?: (data: unknown) => unknown; onError?: (e: Error) => unknown }
  >,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      pharmacyPin: { status: { invalidate: vi.fn() }, members: { invalidate: vi.fn() } },
    }),
    pharmacyPin: {
      status: { useQuery: () => mocks.status },
      members: { useQuery: () => mocks.members },
      setMine: {
        useMutation: (options: (typeof mocks.callbacks)[string]) => {
          mocks.callbacks.setMine = options;
          return { mutate: mocks.setMine, isPending: false };
        },
      },
      resetForMember: {
        useMutation: (options: (typeof mocks.callbacks)[string]) => {
          mocks.callbacks.reset = options;
          return { mutate: mocks.reset, isPending: false };
        },
      },
    },
  },
}));

import { OwnPinSettings } from './own-pin-settings';

const status = (overrides: Partial<Status> = {}): Status => ({
  state: 'NOT_SET',
  locked: false,
  supportSession: false,
  canResetOthers: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.data = status();
  mocks.members.data = [];
});
afterEach(cleanup);

function fill(pin: string, confirm = pin, password = 'my password') {
  fireEvent.change(screen.getByLabelText('Your current password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/^(New )?PIN$/), { target: { value: pin } });
  fireEvent.change(screen.getByLabelText('Type the PIN again'), { target: { value: confirm } });
}

describe('Your PIN', () => {
  it('creates a PIN with the current password, then clears every field', async () => {
    render(<OwnPinSettings onboardingHref="/pharmacy" />);
    expect(screen.getByRole('heading', { name: 'Create your PIN' })).toBeTruthy();
    fill('583917');
    fireEvent.click(screen.getByRole('button', { name: 'Save PIN' }));
    expect(mocks.setMine).toHaveBeenCalledWith({
      currentPassword: 'my password',
      pin: '583917',
      confirmPin: '583917',
    });
    mocks.callbacks.setMine!.onSuccess!({ action: 'created', state: 'SET' });
    expect(await screen.findByRole('status')).toHaveTextContent('Your PIN is set.');
    expect(screen.getByLabelText('Your current password')).toHaveValue('');
    expect(screen.getByLabelText('Type the PIN again')).toHaveValue('');
    expect(screen.getByRole('link', { name: 'Back to onboarding' })).toHaveAttribute(
      'href',
      '/pharmacy'
    );
    expect(document.body.textContent).not.toContain('583917');
  });

  it('explains an easy or mistyped PIN before sending anything', () => {
    render(<OwnPinSettings />);
    fill('1234');
    fireEvent.click(screen.getByRole('button', { name: 'Save PIN' }));
    expect(screen.getByRole('alert')).toHaveTextContent('That PIN is too easy to guess.');
    fill('583917', '583918');
    fireEvent.click(screen.getByRole('button', { name: 'Save PIN' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The two PINs do not match.');
    expect(mocks.setMine).not.toHaveBeenCalled();
  });

  it("shows the server's refusal, such as a wrong password", async () => {
    render(<OwnPinSettings />);
    fill('583917');
    fireEvent.click(screen.getByRole('button', { name: 'Save PIN' }));
    mocks.callbacks.setMine!.onError!(new Error('Your current password is incorrect.'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Your current password is incorrect.')
    );
    expect(screen.getByLabelText('Your current password')).toHaveValue('');
  });

  it('offers a change once a PIN is set, and asks again after a reset', () => {
    mocks.status.data = status({ state: 'SET' });
    const { unmount } = render(<OwnPinSettings />);
    expect(screen.getByRole('heading', { name: 'Change your PIN' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change PIN' })).toBeTruthy();
    unmount();
    mocks.status.data = status({ state: 'RESET' });
    render(<OwnPinSettings />);
    expect(screen.getByText(/Your PIN was reset by the owner or a manager/)).toBeTruthy();
  });

  it('offers no form to a support session', () => {
    mocks.status.data = status({ supportSession: true });
    render(<OwnPinSettings />);
    expect(screen.getByText('A support session cannot set or reset a PIN.')).toBeTruthy();
    expect(screen.queryByLabelText('Your current password')).toBeNull();
  });

  it('lets the owner reset a staff PIN with their password, and never shows staff PINs', () => {
    mocks.status.data = status({ state: 'SET', canResetOthers: true });
    mocks.members.data = [
      { id: 'cashier', name: 'Bilal', hasPin: true, canReset: true },
      { id: 'admin', name: 'Sana', hasPin: true, canReset: false },
      { id: 'new', name: 'Zara', hasPin: false, canReset: true },
    ];
    render(<OwnPinSettings />);
    const list = screen.getByRole('list');
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual(["Reset Bilal's PIN"]);
    fireEvent.click(screen.getByRole('button', { name: "Reset Bilal's PIN" }));
    fireEvent.change(screen.getAllByLabelText('Your current password')[1]!, {
      target: { value: 'owner password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset PIN' }));
    expect(mocks.reset).toHaveBeenCalledWith({
      userId: 'cashier',
      currentPassword: 'owner password',
    });
  });
});
