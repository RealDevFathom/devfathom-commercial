import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AuthShell } from './auth-shell';
import { AuthRecoveryShell } from './auth-recovery-shell';

afterEach(cleanup);
it.each(['default', 'pharmacy', 'restaurant', 'hotel', 'agency'] as const)(
  'renders one main and a keyboard skip destination for %s',
  (vertical) => {
    render(
      <AuthShell vertical={vertical}>
        <h1>Sign in</h1>
      </AuthShell>
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#main-content'
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  }
);
it('keeps recovery context and the same accessible shell', () => {
  render(
    <AuthRecoveryShell context="Account recovery">
      <h1>Reset password</h1>
    </AuthRecoveryShell>
  );
  expect(screen.getByText('Account recovery')).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveClass('studio-auth-main');
  expect(screen.getByRole('heading', { name: 'Reset password' })).toBeInTheDocument();
});
