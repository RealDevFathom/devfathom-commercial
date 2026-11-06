import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// "Sign out everywhere" used to sit inside the Password card, right under
// "Change Password", where it read as part of the password form. It now has its
// own Sessions card and asks for confirmation before ending every session.
const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  onSuccess: undefined as undefined | (() => void),
  signOutEverything: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user_1' } }, status: 'authenticated' }),
  signOut: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/auth/sign-out', () => ({ signOutEverything: mocks.signOutEverything }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    team: {
      signOutEverywhere: {
        useMutation: (options: { onSuccess?: () => void }) => {
          mocks.onSuccess = options.onSuccess;
          return { mutate: mocks.mutate, isPending: false, error: null };
        },
      },
    },
  },
}));

import { SessionsSection } from './settings-content';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onSuccess = undefined;
});

describe('SessionsSection', () => {
  it('is its own Sessions card and confirms before signing out everywhere', async () => {
    render(<SessionsSection />);
    const card = screen.getByRole('region', { name: 'Sessions' });
    fireEvent.click(within(card).getByRole('button', { name: 'Sign out everywhere' }));
    expect(mocks.mutate).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog', { name: 'Sign out of every device?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));

    mocks.onSuccess?.();
    expect(mocks.signOutEverything).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled without signing anything out', async () => {
    render(<SessionsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of every device?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Sign out of every device?' })).toBeNull()
    );
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('is no longer part of the Password card', () => {
    const source = readFileSync(join(__dirname, 'settings-content.tsx'), 'utf8');
    const password = source.slice(
      source.indexOf('function PasswordSection()'),
      source.indexOf('export function SessionsSection()')
    );
    expect(password).toContain('Change Password');
    expect(password).not.toContain('signOutEverywhere');
    expect(password).not.toContain('Sign out everywhere');
    // The page renders the Sessions card right after the Password card.
    expect(source).toMatch(/<PasswordSection \/>[\s\S]*?<SessionsSection \/>/);
  });
});
