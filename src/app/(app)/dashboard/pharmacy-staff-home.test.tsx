import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PharmacyStaffHome } from './pharmacy-staff-home';

const counter = {
  key: 'counter' as const,
  href: '/pharmacy/counter' as const,
  label: 'Open Counter' as const,
  description: 'Ring up sales, take payment and run your cash drawer.' as const,
};

describe('PharmacyStaffHome (DEV-20)', () => {
  it('gives a cashier a direct way to the Counter and shows their own open shift', () => {
    render(
      <PharmacyStaffHome
        home={{
          links: [counter],
          branches: [{ id: 'b1', name: 'Main Branch' }],
          shifts: [
            {
              id: 'd1',
              branchName: 'Main Branch',
              businessDate: '2026-11-15',
              openedAt: '2026-11-15T04:30:00.000Z',
            },
          ],
          timeZone: 'Asia/Karachi',
        }}
      />
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Your work today' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Counter' }).getAttribute('href')).toBe(
      '/pharmacy/counter'
    );
    expect(screen.getByText('Business date 2026-11-15')).toBeTruthy();
    expect(screen.getByText('09:30').getAttribute('datetime')).toBe('2026-11-15T04:30:00.000Z');
    expect(screen.queryByText('Owner command centre')).toBeNull();
    expect(screen.queryByRole('button', { name: /edit dashboard/i })).toBeNull();
  });

  it('explains an empty shift and branch scope instead of erroring', () => {
    render(
      <PharmacyStaffHome home={{ links: [counter], branches: [], shifts: [], timeZone: 'UTC' }} />
    );
    expect(screen.getByText(/no open cash drawer/i)).toBeTruthy();
    expect(screen.getByText(/not assigned to a branch yet/i)).toBeTruthy();
  });

  it('shows no Counter link to a member without counter access', () => {
    render(
      <PharmacyStaffHome
        home={{
          links: [
            {
              key: 'dispense',
              href: '/pharmacy/pharmacist-queue',
              label: 'Pharmacist queue',
              description: 'Review prescriptions and release held items.',
            },
          ],
          branches: [],
          shifts: [],
          timeZone: 'UTC',
        }}
      />
    );
    expect(screen.queryByRole('link', { name: 'Open Counter' })).toBeNull();
    expect(screen.getByRole('link', { name: /Pharmacist queue/ }).getAttribute('href')).toBe(
      '/pharmacy/pharmacist-queue'
    );
  });
});
