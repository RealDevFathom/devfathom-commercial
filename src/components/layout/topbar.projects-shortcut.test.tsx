import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Regression (#980): the header "+" shortcut sent pharmacy members to /projects, a module
// their package never licenses ("module not enabled").
const mocks = vi.hoisted(() => ({ vertical: 'AGENCY' as string }));

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: mocks.vertical, enabledModules: [] }),
}));
vi.mock('@/lib/trpc', () => ({ trpc: {} }));

import { ProjectsShortcut } from './topbar';

afterEach(cleanup);

describe('Topbar projects shortcut', () => {
  it('is not rendered for a pharmacy tenant', () => {
    mocks.vertical = 'PHARMACY';
    render(<ProjectsShortcut />);
    expect(screen.queryByRole('link', { name: 'Open projects' })).not.toBeInTheDocument();
  });

  it.each(['AGENCY', 'RESTAURANT', 'HOSPITALITY'])('stays available for %s', (vertical) => {
    mocks.vertical = vertical;
    render(<ProjectsShortcut />);
    expect(screen.getByRole('link', { name: 'Open projects' })).toHaveAttribute(
      'href',
      '/projects'
    );
  });
});
