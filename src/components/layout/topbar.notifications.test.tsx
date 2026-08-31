import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  vertical: 'AGENCY',
  teamQuery: vi.fn(),
  teamMarkRead: vi.fn(),
  teamMarkAllRead: vi.fn(),
  restaurantQuery: vi.fn(),
  restaurantMarkRead: vi.fn(),
  restaurantMarkAllRead: vi.fn(),
}));

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: mocks.vertical, enabledModules: [] }),
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
  mocks.teamQuery.mockReturnValue({ data: [] });
  mocks.restaurantQuery.mockReturnValue({ data: { items: [] } });
  mocks.teamMarkRead.mockReturnValue({ mutate: vi.fn() });
  mocks.teamMarkAllRead.mockReturnValue({ mutate: vi.fn() });
  mocks.restaurantMarkRead.mockReturnValue({ mutate: vi.fn() });
  mocks.restaurantMarkAllRead.mockReturnValue({ mutate: vi.fn() });
});

describe('NotificationBell vertical routing', () => {
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
