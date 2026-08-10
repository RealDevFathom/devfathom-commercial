/**
 * Meetings page pagination (#38).
 *
 * The page used to stack two silent truncations: `getAll` was fetched with no
 * input (unbounded server-side) and the Past list then cut the result to ten
 * with a bare `.slice(0, 10)`. Nothing told the user either had happened.
 *
 * These cases pin the replacement: everything loaded is rendered, and whenever
 * the server says another page exists the control that fetches it is on screen
 * — including on a page that happens to contain no past meeting at all, which
 * is reachable because the list is ordered by start time descending.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const HOUR = 60 * 60 * 1000;

type Meeting = {
  id: string;
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  location: string | null;
  recurrence: string | null;
  attendees: Array<{ joinedAt?: Date | null; user: { id: string; name: string; avatar: null } }>;
};

const meeting = (title: string, startTime: Date): Meeting => ({
  id: title,
  title,
  description: null,
  startTime,
  endTime: new Date(startTime.getTime() + HOUR),
  location: null,
  recurrence: null,
  attendees: [],
});

const mocks = vi.hoisted(() => ({
  pages: [] as Array<{ items: unknown[]; nextCursor?: string }>,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user_1', name: 'Member', role: 'EMPLOYEE' } } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/lib/trpc', () => {
  const mutation = () => ({ useMutation: () => ({ mutate: vi.fn(), isPending: false }) });
  return {
    trpc: {
      useUtils: () => ({
        meetings: {
          getUpcoming: { invalidate: vi.fn() },
          getAll: { invalidate: vi.fn() },
        },
      }),
      meetings: {
        getUpcoming: { useQuery: () => ({ data: [], isLoading: false }) },
        getAll: {
          useInfiniteQuery: () => ({
            data: { pages: mocks.pages },
            fetchNextPage: mocks.fetchNextPage,
            hasNextPage: mocks.hasNextPage,
            isFetchingNextPage: false,
          }),
        },
        create: mutation(),
        update: mutation(),
        delete: mutation(),
      },
      team: { getAll: { useQuery: () => ({ data: [] }) } },
    },
  };
});

const { MeetingsContent } = await import('./meetings-content');

const past = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    meeting(`Past meeting ${i}`, new Date(Date.now() - (i + 2) * HOUR))
  );

describe('MeetingsContent pagination', () => {
  beforeEach(() => {
    mocks.pages = [];
    mocks.hasNextPage = false;
    mocks.fetchNextPage.mockClear();
  });

  // The `.slice(0, 10)` this replaces dropped meetings 11..25 with no trace.
  it('renders every loaded past meeting, not the first ten', () => {
    mocks.pages = [{ items: past(25) }];

    render(<MeetingsContent />);

    expect(screen.getByText('Past meeting 0')).toBeInTheDocument();
    expect(screen.getByText('Past meeting 10')).toBeInTheDocument();
    expect(screen.getByText('Past meeting 24')).toBeInTheDocument();
  });

  it('offers a way past the page when the server reports more', () => {
    mocks.pages = [{ items: past(50), nextCursor: 'cursor_1' }];
    mocks.hasNextPage = true;

    render(<MeetingsContent />);

    const loadMore = screen.getByRole('button', { name: /load more/i });
    expect(screen.getByText(/more remain/i)).toBeInTheDocument();

    fireEvent.click(loadMore);
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  // Pages are ordered by start time descending, so the first page of a busy
  // calendar can be entirely future meetings. If the continuation control
  // hung off the past list being non-empty, that page would be a dead end.
  it('keeps the continuation control reachable on a page with no past meeting', () => {
    mocks.pages = [{ items: [meeting('Future meeting', new Date(Date.now() + 48 * HOUR))] }];
    mocks.hasNextPage = true;

    render(<MeetingsContent />);

    expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
  });

  it('offers nothing more when the last page is loaded', () => {
    mocks.pages = [{ items: past(3) }];
    mocks.hasNextPage = false;

    render(<MeetingsContent />);

    expect(screen.getByText('Past meeting 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});
