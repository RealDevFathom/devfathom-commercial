import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  vertical: 'AGENCY',
  enabledModules: [] as string[],
  teamQuery: vi.fn(),
  teamMarkRead: vi.fn(),
  teamMarkAllRead: vi.fn(),
  restaurantQuery: vi.fn(),
  restaurantMarkRead: vi.fn(),
  restaurantMarkAllRead: vi.fn(),
}));

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: mocks.vertical, enabledModules: mocks.enabledModules }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      team: {
        getNotifications: {
          cancel: vi.fn(),
          getData: vi.fn(),
          setData: vi.fn(),
          invalidate: vi.fn(),
        },
      },
      restaurantNotifications: { list: { invalidate: vi.fn() } },
    }),
    team: {
      getNotifications: { useQuery: mocks.teamQuery },
      markNotificationRead: { useMutation: mocks.teamMarkRead },
      markAllNotificationsRead: { useMutation: mocks.teamMarkAllRead },
    },
    restaurantNotifications: {
      list: { useQuery: mocks.restaurantQuery },
      markRead: { useMutation: mocks.restaurantMarkRead },
      markAllRead: { useMutation: mocks.restaurantMarkAllRead },
    },
  },
}));

import { NotificationBell } from './topbar';

beforeEach(() => {
  vi.clearAllMocks();
  // Shell notifications remain available with or without an HR entitlement.
  mocks.enabledModules = ['hr'];
  mocks.teamQuery.mockReturnValue({ data: [] });
  mocks.restaurantQuery.mockReturnValue({ data: { items: [] } });
  mocks.teamMarkRead.mockReturnValue({ mutate: vi.fn() });
  mocks.teamMarkAllRead.mockReturnValue({ mutate: vi.fn() });
  mocks.restaurantMarkRead.mockReturnValue({ mutate: vi.fn() });
  mocks.restaurantMarkAllRead.mockReturnValue({ mutate: vi.fn() });
});

describe('NotificationBell vertical routing', () => {
  // DEV-1005: the pharmacy counter (a touch screen) asks for the 44px target; every other
  // bar keeps the compact 36px bell.
  it.each(['AGENCY', 'RESTAURANT'] as const)(
    'keeps the %s bell compact unless a touch target is asked for',
    (vertical) => {
      mocks.vertical = vertical;
      mocks.teamQuery.mockReturnValue({ data: [] });
      mocks.restaurantQuery.mockReturnValue({ data: { items: [] } });
      const view = render(<NotificationBell />);
      expect(screen.getByRole('button', { name: 'Notifications' })).toHaveClass('h-9', 'w-9');
      expect(screen.getByRole('button', { name: 'Notifications' })).not.toHaveClass('size-11');
      view.unmount();
      render(<NotificationBell touchTarget />);
      expect(screen.getByRole('button', { name: 'Notifications' })).toHaveClass('size-11');
      expect(screen.getByRole('button', { name: 'Notifications' })).not.toHaveClass('h-9');
    }
  );

  it('uses only Agency team notification procedures for an Agency tenant', () => {
    mocks.vertical = 'AGENCY';
    const markRead = vi.fn();
    const markAllRead = vi.fn();
    mocks.teamMarkRead.mockReturnValue({ mutate: markRead });
    mocks.teamMarkAllRead.mockReturnValue({ mutate: markAllRead });
    mocks.teamQuery.mockReturnValue({
      data: [
        {
          id: 'team-1',
          title: 'Agency update',
          message: 'The existing team notification body',
          createdAt: new Date(),
          isRead: false,
        },
      ],
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(screen.getByText('Agency update'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));

    expect(screen.getByText('The existing team notification body')).toBeInTheDocument();
    expect(markRead).toHaveBeenCalledWith({ id: 'team-1' });
    expect(markAllRead).toHaveBeenCalledWith();
    expect(mocks.teamQuery).toHaveBeenCalledOnce();
    expect(mocks.restaurantQuery).not.toHaveBeenCalled();
    expect(mocks.restaurantMarkRead).not.toHaveBeenCalled();
    expect(mocks.restaurantMarkAllRead).not.toHaveBeenCalled();
  });

  it('uses only Restaurant procedures and maps body into the existing bell UI', () => {
    mocks.vertical = 'RESTAURANT';
    const markRead = vi.fn();
    const markAllRead = vi.fn();
    mocks.restaurantMarkRead.mockReturnValue({ mutate: markRead });
    mocks.restaurantMarkAllRead.mockReturnValue({ mutate: markAllRead });
    mocks.restaurantQuery.mockReturnValue({
      data: {
        items: [
          {
            id: 'restaurant-1',
            title: 'Table needs attention',
            body: 'Guest has been waiting for ten minutes',
            createdAt: new Date(),
            isRead: false,
          },
        ],
      },
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(screen.getByText('Table needs attention'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));

    expect(screen.getByText('Guest has been waiting for ten minutes')).toBeInTheDocument();
    expect(markRead).toHaveBeenCalledWith({ id: 'restaurant-1' });
    expect(markAllRead).toHaveBeenCalledWith({});
    expect(mocks.restaurantQuery).toHaveBeenCalledWith({ limit: 50, unreadOnly: false });
    expect(mocks.teamQuery).not.toHaveBeenCalled();
    expect(mocks.teamMarkRead).not.toHaveBeenCalled();
    expect(mocks.teamMarkAllRead).not.toHaveBeenCalled();
  });
});

/**
 * WHA-1181 — an administrator with no staff profile is denied the poll outright.
 * `retryQuery` stops the retry storm; the bell's job is to say so once instead
 * of showing a bare "No notifications" over an error.
 */
describe('Restaurant notification bell when the poll is denied', () => {
  beforeEach(() => {
    mocks.vertical = 'RESTAURANT';
  });

  it('renders one quiet state naming the missing staff profile', () => {
    mocks.restaurantQuery.mockReturnValue({
      data: undefined,
      error: { data: { code: 'FORBIDDEN' } },
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(screen.getByText('Notifications need a restaurant staff profile')).toBeInTheDocument();
    expect(screen.queryByText('No notifications')).not.toBeInTheDocument();
    // No unread badge and no "Mark all read": there is nothing to act on.
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
  });

  it('keeps the ordinary empty state for a granted but empty list', () => {
    mocks.restaurantQuery.mockReturnValue({ data: { items: [] }, error: null });

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });

  it('does not mistake a non-authorization failure for the missing-profile state', () => {
    mocks.restaurantQuery.mockReturnValue({
      data: undefined,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });
});

/**
 * WHA-305 — every non-Restaurant vertical uses the shared team bell. Its
 * personal notification procedures are available without HR; keep client
 * polling and read actions aligned with the server's exact-path exception.
 * A server-side denial must still override any cached notification data.
 */
describe('Team notification bell without an HR entitlement', () => {
  beforeEach(() => {
    mocks.vertical = 'PHARMACY';
    // A pharmacy package: pharmacy modules, no `hr`.
    mocks.enabledModules = ['pharmacy-core', 'pharmacy-inventory', 'dashboard'];
    mocks.teamQuery.mockReturnValue({ data: undefined, error: null });
  });

  it('polls for personal notifications when HR is absent', () => {
    render(<NotificationBell />);

    expect(mocks.teamQuery).toHaveBeenCalledOnce();
    expect(mocks.teamQuery).toHaveBeenCalledWith(undefined, { enabled: true });
    // The Restaurant bell must stay untouched: this is the shared fallback path.
    expect(mocks.restaurantQuery).not.toHaveBeenCalled();
  });

  it('shows the ordinary empty inbox when HR is absent', () => {
    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(screen.getByText('No notifications')).toBeInTheDocument();
    expect(
      screen.queryByText('Notifications are not part of this workspace’s plan')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Ask your platform administrator to enable the HR module.')
    ).not.toBeInTheDocument();
    // Nothing to act on: no unread badge, no "Mark all read".
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
  });

  it.each([false, true])('renders and marks notifications read with HR enabled=%s', (hasHr) => {
    if (hasHr) mocks.enabledModules.push('hr');
    const markRead = vi.fn();
    const markAllRead = vi.fn();
    mocks.teamMarkRead.mockReturnValue({ mutate: markRead });
    mocks.teamMarkAllRead.mockReturnValue({ mutate: markAllRead });
    mocks.teamQuery.mockReturnValue({
      data: [
        {
          id: 'team-1',
          title: 'Personal update',
          message: 'Body of a personal notification',
          createdAt: new Date(),
          isRead: false,
        },
      ],
      error: null,
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));

    expect(mocks.teamQuery).toHaveBeenCalledWith(undefined, { enabled: true });
    expect(screen.getByText('Body of a personal notification')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Personal update'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(markRead).toHaveBeenCalledExactlyOnceWith({ id: 'team-1' });
    expect(markAllRead).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.restaurantQuery).not.toHaveBeenCalled();
    expect(
      screen.queryByText('Notifications are not part of this workspace’s plan')
    ).not.toBeInTheDocument();
  });

  it.each([false, true])('honours a server denial with HR enabled=%s', (hasHr) => {
    if (hasHr) mocks.enabledModules.push('hr');
    mocks.teamQuery.mockReturnValue({
      data: [
        {
          id: 'cached-1',
          title: 'Cached notification',
          message: 'Cached body',
          createdAt: new Date(),
          isRead: false,
        },
      ],
      error: { data: { code: 'FORBIDDEN' } },
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(
      screen.getByText('Notifications are not part of this workspace’s plan')
    ).toBeInTheDocument();
    expect(screen.queryByText('No notifications')).not.toBeInTheDocument();
    expect(screen.queryByText('Cached notification')).not.toBeInTheDocument();
    expect(screen.queryByText('Cached body')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
  });

  it('does not mistake a non-authorization failure for a permission denial', () => {
    mocks.enabledModules = ['pharmacy-core', 'hr'];
    mocks.teamQuery.mockReturnValue({
      data: undefined,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(screen.getByText('No notifications')).toBeInTheDocument();
    expect(
      screen.queryByText('Notifications are not part of this workspace’s plan')
    ).not.toBeInTheDocument();
  });
});
