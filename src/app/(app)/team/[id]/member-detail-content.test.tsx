import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `team.getById` gives a viewer a colleague's projects and tasks only as far as
 * the viewer could see them anyway, and says which (`workScope`). The page keeps
 * working with the reduced lists and never words a filtered list as the whole:
 * "No projects assigned" would tell a member their colleague is idle.
 */
const state = vi.hoisted(() => ({ member: null as unknown }));
const idle = { data: undefined, isLoading: false, isError: false };
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'viewer', role: 'EMPLOYEE' } } }),
}));
vi.mock('@/lib/breadcrumb-store', () => ({ useBreadcrumbLabel: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    team: {
      getById: { useQuery: () => ({ data: state.member, isLoading: false }) },
      listPerformanceNotes: { useQuery: () => idle },
      getLeaveBalances: { useQuery: () => idle },
    },
    teamStats: { getForUser: { useQuery: () => idle } },
  },
}));
import { MemberDetailContent } from './member-detail-content';

function colleague(overrides: Record<string, unknown>) {
  return {
    id: 'colleague',
    name: 'Front Desk',
    email: '',
    phone: null,
    role: 'EMPLOYEE',
    department: 'OPS',
    title: 'Receptionist',
    avatar: null,
    bio: null,
    skills: [],
    startDate: new Date('2026-01-05T00:00:00.000Z'),
    status: 'ACTIVE',
    lastActiveAt: null,
    projectMembers: [],
    assignedTasks: [],
    leaveRequests: false,
    workScope: { projects: 'SHARED', tasks: 'VISIBLE' },
    ...overrides,
  };
}
const sharedProject = {
  role: 'MEMBER',
  project: { id: 'project-shared', name: 'Lobby refit', status: 'ACTIVE', type: 'INTERNAL' },
};
const visibleTask = {
  task: {
    id: 'task-visible',
    title: 'Order signage',
    priority: 'HIGH',
    dueDate: null,
    column: { name: 'To do' },
  },
};

beforeEach(() => {
  state.member = colleague({});
});
afterEach(cleanup);

describe('member page with a colleague’s reduced work lists', () => {
  it('heads the lists as the viewer’s share, linking only the projects returned', () => {
    state.member = colleague({ projectMembers: [sharedProject], assignedTasks: [visibleTask] });
    render(<MemberDetailContent memberId="colleague" />);
    expect(screen.getByText(/Shared projects \(\s*1\s*\)/)).toBeInTheDocument();
    const project = screen.getByRole('link', { name: /Lobby refit/ });
    expect(project).toHaveAttribute('href', '/projects/project-shared');
    expect(screen.getByText('Tasks you can see')).toBeInTheDocument();
    expect(screen.getByText('Order signage')).toBeInTheDocument();
  });

  it('says the viewer shares no projects and sees no tasks, not that none are assigned', () => {
    render(<MemberDetailContent memberId="colleague" />);
    expect(screen.getByText('No projects you share')).toBeInTheDocument();
    expect(screen.getByText('No tasks you can see')).toBeInTheDocument();
    expect(screen.queryByText(/No (projects|tasks) assigned/)).not.toBeInTheDocument();
  });

  it('keeps the whole-list wording when the lists are whole', () => {
    state.member = colleague({
      email: 'front.desk@example.test',
      projectMembers: [sharedProject],
      workScope: { projects: 'ALL', tasks: 'ALL' },
    });
    render(<MemberDetailContent memberId="colleague" />);
    expect(screen.getByText(/Projects \(\s*1\s*\)/)).not.toHaveTextContent('Shared');
    expect(screen.getByText('No tasks assigned')).toBeInTheDocument();
    expect(screen.queryByText('Tasks you can see')).not.toBeInTheDocument();
  });
});
