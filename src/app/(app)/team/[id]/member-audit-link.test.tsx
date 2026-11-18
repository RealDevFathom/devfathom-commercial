import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntitlementsProvider } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';

// DEV-913: an administrator reaches each staff member's actions from the
// profile, in every pharmacy workspace whatever its plan.

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'owner', role: 'ADMIN' } } }),
}));
vi.mock('@/lib/breadcrumb-store', () => ({ useBreadcrumbLabel: vi.fn() }));
vi.mock('@/lib/trpc', () => {
  const idle = { data: undefined, isLoading: false, isError: false, isPending: false };
  const member = {
    id: 'cashier-1',
    name: 'Amina Cashier',
    email: '',
    phone: null,
    role: 'EMPLOYEE',
    department: 'OPS',
    title: 'Cashier',
    avatar: null,
    bio: null,
    skills: [],
    startDate: new Date('2026-01-05T00:00:00.000Z'),
    status: 'ACTIVE',
    lastActiveAt: null,
    projectMembers: [],
    assignedTasks: [],
    leaveRequests: false,
    workScope: { projects: 'ALL', tasks: 'ALL' },
  };
  const procedure = (path: string): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key: string) => {
        if (key === 'useQuery')
          return () => (path === 'team.getById' ? { data: member, isLoading: false } : idle);
        if (key === 'useMutation') return () => ({ mutate: vi.fn(), ...idle });
        if (key === 'useUtils') return () => procedure('utils');
        return procedure(path ? `${path}.${key}` : key);
      },
    });
  return { trpc: procedure('') };
});

import { MemberDetailContent } from './member-detail-content';

const entitlements = (vertical: EntitlementView['vertical'], enabledModules: string[]) =>
  ({
    organizationId: 'org_1',
    vertical,
    enabledModules,
    modules: [],
    limits: {},
    seatLimit: 5,
    activeSeats: 1,
  }) satisfies EntitlementView;

afterEach(cleanup);

describe('staff profile link to the audit log', () => {
  it('links a pharmacy administrator to this person’s actions without the audit module', () => {
    render(
      <EntitlementsProvider value={entitlements('PHARMACY', ['pharmacy-core'])}>
        <MemberDetailContent memberId="cashier-1" />
      </EntitlementsProvider>
    );
    expect(screen.getByRole('link', { name: /See their actions/ })).toHaveAttribute(
      'href',
      '/audit-logs?actorId=cashier-1'
    );
  });

  it('offers no link where the audit log is not part of the plan', () => {
    render(
      <EntitlementsProvider value={entitlements('AGENCY', ['hr'])}>
        <MemberDetailContent memberId="cashier-1" />
      </EntitlementsProvider>
    );
    expect(screen.queryByRole('link', { name: /See their actions/ })).toBeNull();
  });
});
