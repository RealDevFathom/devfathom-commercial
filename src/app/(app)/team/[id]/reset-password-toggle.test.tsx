import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/lib/breadcrumb-store', () => ({ useBreadcrumbLabel: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    team: { adminResetPassword: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
  },
}));
import { ResetPasswordForm } from './member-detail-content';

afterEach(cleanup);

describe('admin reset-password show/hide toggle', () => {
  it('is labelled, keyboard reachable and toggles the field type', () => {
    render(
      <ResetPasswordForm
        memberId="m1"
        memberName="Ayesha"
        onClose={() => {}}
        onSuccess={() => {}}
      />
    );
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle.getAttribute('tabindex')).not.toBe('-1');
    const input = screen.getByPlaceholderText(/New password/) as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
  });
});
