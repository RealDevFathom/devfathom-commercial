import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

import { PlatformLoginForm } from './platform-login-form';

describe('PlatformLoginForm password visibility', () => {
  it('keeps the show-password button in the keyboard tab order', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    render(<PlatformLoginForm />);

    expect(screen.getByRole('button', { name: 'Show password' })).not.toHaveAttribute(
      'tabindex',
      '-1'
    );
  });
});
