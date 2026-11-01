import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  entitlements: { vertical: 'PHARMACY', enabledModules: [] as string[] } as Pick<
    EntitlementView,
    'vertical' | 'enabledModules'
  >,
  role: 'ADMIN',
}));

// Render the lazily-loaded cmdk primitives synchronously as plain elements.
vi.mock('next/dynamic', () => ({
  default: (loader: { toString(): string }) => {
    const source = loader.toString();
    if (source.includes('CommandGroup'))
      return ({ heading, children }: { heading?: string; children?: React.ReactNode }) => (
        <div role="group" aria-label={heading}>
          {children}
        </div>
      );
    if (source.includes('CommandItem'))
      return ({ children, onSelect }: { children?: React.ReactNode; onSelect?: () => void }) => (
        <button type="button" onClick={onSelect}>
          {children}
        </button>
      );
    return () => null;
  },
}));

// The palette reads the sidebar's own filter: feed it the real visibleNavigation.
vi.mock('./sidebar', async () => {
  const actual = await vi.importActual<typeof import('./sidebar')>('./sidebar');
  return {
    ...actual,
    useVisibleNavigation: () => ({
      filteredNav: actual.visibleNavigation(mocks.entitlements, mocks.role),
      bestMatch: '',
      indexByHref: new Map(),
    }),
  };
});
vi.mock('@/lib/trpc', () => ({ trpc: {} }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));

import { commandPlaceholder, headerRoleLine, PaletteNavigation } from './topbar';

afterEach(cleanup);

const AGENCY_AND_HOTEL_SCREENS = [
  'Projects',
  'Clients',
  'Notes',
  'Email',
  'Meetings',
  'HR & Leave',
  'Front desk',
  'Housekeeping',
];

function labels() {
  return screen.queryAllByRole('button').map((button) => button.textContent);
}

describe('command palette navigation', () => {
  it('lists only the pharmacy screens the sidebar shows, not other verticals', () => {
    mocks.entitlements = {
      vertical: 'PHARMACY',
      // Even a mis-provisioned agency module must not leak into the palette.
      enabledModules: ['pharmacy-core', 'pharmacy-counter', 'projects', 'clients'],
    };
    mocks.role = 'ADMIN';
    render(<PaletteNavigation onSelect={vi.fn()} />);

    const shown = labels();
    expect(shown).toContain('Dashboard');
    expect(shown).toContain('Counter');
    for (const label of AGENCY_AND_HOTEL_SCREENS) expect(shown).not.toContain(label);
  });

  it('drops a screen whose module is not enabled', () => {
    mocks.entitlements = { vertical: 'PHARMACY', enabledModules: ['pharmacy-core'] };
    render(<PaletteNavigation onSelect={vi.fn()} />);
    expect(labels()).not.toContain('Counter');
  });

  it('filters screens by the typed query and navigates on select', () => {
    mocks.entitlements = {
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-core', 'pharmacy-counter'],
    };
    const onSelect = vi.fn();
    render(<PaletteNavigation onSelect={onSelect} query="count" />);
    expect(screen.getByRole('group', { name: 'Screens' })).toBeTruthy();
    expect(labels()).not.toContain('Dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Counter' }));
    expect(onSelect).toHaveBeenCalledWith('/pharmacy/counter');
  });

  it('renders nothing when no screen matches the query', () => {
    mocks.entitlements = { vertical: 'PHARMACY', enabledModules: ['pharmacy-core'] };
    const { container } = render(<PaletteNavigation onSelect={vi.fn()} query="projects" />);
    expect(container.textContent).toBe('');
  });
});

describe('command palette placeholder', () => {
  it('speaks pharmacy in a pharmacy workspace', () => {
    expect(commandPlaceholder('PHARMACY')).toBe('Search pharmacy screens, team…');
    expect(commandPlaceholder('PHARMACY')).not.toMatch(/projects|clients|notes/i);
  });

  it('keeps the workspace placeholder elsewhere', () => {
    expect(commandPlaceholder('AGENCY')).toBe('Search projects, tasks, clients, notes, team…');
  });
});

describe('header role line', () => {
  it('shows the actual role in pharmacy, not the job title', () => {
    expect(headerRoleLine('PHARMACY', 'Owner', 'Owner (QA test login)')).toBe('Owner');
    expect(headerRoleLine('PHARMACY', 'Staff', 'Procurement approver')).toBe('Staff');
  });

  it('keeps the job title for other verticals', () => {
    expect(headerRoleLine('AGENCY', 'Admin', 'Project Manager')).toBe('Project Manager');
    expect(headerRoleLine('AGENCY', 'Admin', undefined)).toBe('Team member');
  });
});
