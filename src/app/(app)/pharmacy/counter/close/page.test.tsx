import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  can: vi.fn(),
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string; role?: string | null }) => ({
    id: user.id,
    role: user.role ?? 'EMPLOYEE',
    department: null,
    status: null,
  }),
}));
vi.mock('@/components/pharmacy/counter/day-close-console', () => ({
  PHARMACY_DAY_CLOSE_DENIED: 'Only a manager or owner can close the day.',
  PharmacyDayCloseConsole: () => <p>Day close console</p>,
}));

import PharmacyDayClosePage from './page';

function signIn(role: string, grants: readonly string[]) {
  mocks.context.mockResolvedValue({ session: { user: { id: `${role}-user`, role } }, db: {} });
  mocks.can.mockImplementation(async (_subject: unknown, action: string) =>
    grants.includes(action)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Pharmacy day close page access', () => {
  it('refuses a cashier who opens the URL directly, without the console', async () => {
    signIn('EMPLOYEE', ['pharmacy:counter', 'pharmacy:orders']);
    render(await PharmacyDayClosePage());
    expect(screen.getByText('Only a manager or owner can close the day.')).toBeInTheDocument();
    expect(screen.queryByText('Day close console')).not.toBeInTheDocument();
  });

  it.each([
    ['owner', 'ADMIN', ['reports:operational', 'pharmacy:close']],
    ['admin', 'ADMIN', []],
    ['day-close holder', 'EMPLOYEE', ['pharmacy:close']],
  ] as const)('opens the console for the %s', async (_persona, role, grants) => {
    signIn(role, grants);
    render(await PharmacyDayClosePage());
    expect(screen.getByText('Day close console')).toBeInTheDocument();
  });
});
