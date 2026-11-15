import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformIdentity } from '@/lib/platform/auth';
import { PlatformShell } from './platform-shell';

vi.mock('next/navigation', () => ({
  usePathname: () => '/platform',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

const identity: PlatformIdentity = {
  sessionId: 'session-1',
  id: 'operator-1',
  name: 'E2E Platform Operator',
  email: 'platform-operator@e2e.invalid',
  role: 'SUPER_ADMIN',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  mfaEnabled: true,
};

/** Enter/Space on a button dispatches a click with `detail === 0`. */
const KEYBOARD_ACTIVATION = { detail: 0 };
const POINTER_ACTIVATION = { detail: 1 };

function renderShell() {
  render(
    <PlatformShell identity={identity}>
      <p>Control room</p>
    </PlatformShell>
  );
  return screen.getByRole('button', { name: 'Open platform navigation' });
}

const drawer = () => screen.queryByRole('complementary', { name: 'Platform navigation' });

describe('PlatformShell compact navigation', () => {
  it('names the platform logo link and points it to platform home', () => {
    renderShell();

    const link = screen.getByRole('link', { name: 'DevFathom Platform control home' });
    expect(link).toHaveAttribute('href', '/platform');
    // WCAG 2.5.3: the accessible name must contain the visible label text.
    expect(link.getAttribute('aria-label')).toContain('DevFathom Platform control');
    expect(link).toHaveTextContent('DevFathom');
    expect(link).toHaveTextContent('Platform control');
  });

  it('returns focus to the trigger when the close button is activated by keyboard', () => {
    const trigger = renderShell();

    trigger.focus();
    fireEvent.click(trigger, KEYBOARD_ACTIVATION);
    expect(drawer()).toBeInTheDocument();

    const close = screen.getByRole('button', { name: 'Close menu' });
    close.focus();
    expect(close).toHaveFocus();
    fireEvent.click(close, KEYBOARD_ACTIVATION);

    expect(drawer()).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const trigger = renderShell();

    trigger.focus();
    fireEvent.click(trigger, KEYBOARD_ACTIVATION);
    expect(drawer()).toBeInTheDocument();

    screen.getByRole('button', { name: 'Close menu' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(drawer()).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('leaves focus alone when the drawer is closed by pointer', () => {
    const trigger = renderShell();

    fireEvent.click(trigger, POINTER_ACTIVATION);
    expect(drawer()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }), POINTER_ACTIVATION);

    expect(drawer()).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
  });
});
