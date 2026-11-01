import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { passwordRules } from '@/lib/password-policy';

const mocks = vi.hoisted(() => ({
  changeMutate: vi.fn(),
  signOutMutate: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'authenticated' }),
  signOut: vi.fn(),
}));
vi.mock('@/lib/auth/sign-out', () => ({ signOutEverything: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    team: {
      changePassword: { useMutation: () => ({ mutate: mocks.changeMutate, isPending: false }) },
      signOutEverywhere: {
        useMutation: () => ({ mutate: mocks.signOutMutate, isPending: false }),
      },
    },
  },
}));

import { PasswordSection, passwordChangeBlocker } from './settings-content';

beforeEach(() => vi.clearAllMocks());

describe('passwordChangeBlocker', () => {
  it('names the first thing stopping a password change', () => {
    expect(passwordChangeBlocker({ current: '', newPw: '', confirm: '' })).toBe(
      'Enter your current password.'
    );
    expect(passwordChangeBlocker({ current: 'old', newPw: '', confirm: '' })).toBe(
      'Enter a new password.'
    );
    expect(passwordChangeBlocker({ current: 'old', newPw: 'abc', confirm: '' })).toBe(
      'New password needs: at least 8 characters.'
    );
    expect(passwordChangeBlocker({ current: 'old', newPw: 'abcdefgh1', confirm: '' })).toBe(
      'New password needs: one uppercase letter.'
    );
    expect(passwordChangeBlocker({ current: 'old', newPw: 'Abcdefgh1', confirm: '' })).toBe(
      'Type the new password again to confirm it.'
    );
    expect(
      passwordChangeBlocker({ current: 'old', newPw: 'Abcdefgh1', confirm: 'Abcdefgh2' })
    ).toBe('Passwords don’t match.');
    expect(
      passwordChangeBlocker({ current: 'old', newPw: 'Abcdefgh1', confirm: 'Abcdefgh1' })
    ).toBeNull();
  });
});

describe('PasswordSection', () => {
  it('lists the shared password rules before anything is typed', () => {
    render(<PasswordSection />);
    for (const rule of passwordRules) expect(screen.getByText(rule.label)).toBeInTheDocument();
  });

  it('explains why Change Password is disabled', () => {
    render(<PasswordSection />);
    const button = screen.getByRole('button', { name: /Change Password/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Enter your current password.');
  });

  it('warns that signing out everywhere includes this device', () => {
    render(<PasswordSection />);
    expect(screen.getByText(/including this one/i)).toBeInTheDocument();
  });
});
