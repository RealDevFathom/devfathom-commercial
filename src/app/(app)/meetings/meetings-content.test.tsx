/**
 * Meetings page pagination (#38, #44).
 *
 * #38 replaced two silent truncations — an unbounded `getAll` fetch and a bare
 * `.slice(0, 10)` on the Past list — with one bounded page plus a control that
 * reaches the rest.
 *
 * #44 replaces where Past comes FROM. It used to be derived client-side from
 * whatever `getAll` had loaded, and `getAll` is ordered furthest-future first:
 * on a calendar whose future exceeds one page, every early page was
 * future-only, so the Past section read "0 past of 50 meetings loaded" until
 * the user had clicked through the entire future calendar. Past now has its own
 * server-side query and its own cursor.
 *
 * These cases pin the replacement: the first render shows past meetings no
 * matter how large Upcoming is, everything loaded is rendered, and whenever the
 * server says another PAST page exists the control that fetches it is on
 * screen.
 *
 * DEV-249 / #451 adds the time-order cases at the bottom: the create and edit
 * forms refuse a meeting that ends at or before it starts.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MEETING_TIME_ORDER_MESSAGE } from '@/lib/meetings/time-order';

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
  upcoming: [] as unknown[],
  pages: [] as Array<{ items: unknown[]; nextCursor?: string }>,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  mutate: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  errors: {} as Partial<Record<'create' | 'update' | 'delete', { message: string }>>,
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
  const mutation = (name: 'create' | 'update' | 'delete') => ({
    useMutation: () => ({
      mutate: mocks.mutate[name],
      isPending: false,
      error: mocks.errors[name] ?? null,
      reset: vi.fn(),
    }),
  });
  return {
    trpc: {
      useUtils: () => ({
        meetings: {
          getUpcoming: { invalidate: vi.fn() },
          getPast: { invalidate: vi.fn() },
        },
      }),
      meetings: {
        getUpcoming: { useQuery: () => ({ data: mocks.upcoming, isLoading: false }) },
        // Past has its own infinite query, entirely separate from Upcoming's.
        getPast: {
          useInfiniteQuery: () => ({
            data: { pages: mocks.pages },
            fetchNextPage: mocks.fetchNextPage,
            hasNextPage: mocks.hasNextPage,
            isFetchingNextPage: false,
          }),
        },
        create: mutation('create'),
        update: mutation('update'),
        delete: mutation('delete'),
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

const future = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    meeting(`Future meeting ${i}`, new Date(Date.now() + (i + 2) * HOUR))
  );

describe('MeetingsContent pagination', () => {
  beforeEach(() => {
    mocks.upcoming = [];
    mocks.pages = [];
    mocks.hasNextPage = false;
    mocks.fetchNextPage.mockClear();
  });

  // The defect issue #44 reports, at the surface that shows it. A tenant whose
  // future calendar runs well past one page used to render an empty Past
  // section, because Past was filtered out of a future-ordered page of
  // `getAll`. Past now arrives on its own, so the very first render carries it
  // — with no "Load more" click, and none needed.
  it('shows past meetings on first render however large the future calendar is', () => {
    mocks.upcoming = future(120);
    mocks.pages = [{ items: past(50), nextCursor: 'cursor_1' }];
    mocks.hasNextPage = true;

    render(<MeetingsContent />);

    expect(screen.getByText('Past meeting 0')).toBeInTheDocument();
    expect(screen.getByText('Past meeting 49')).toBeInTheDocument();
    // Nothing was clicked, and nothing had to be.
    expect(mocks.fetchNextPage).not.toHaveBeenCalled();
    // The future calendar is genuinely larger than a page — the fixture
    // reproduces the reported condition rather than dodging it.
    expect(screen.getByText('Future meeting 119')).toBeInTheDocument();
  });

  // The `.slice(0, 10)` this replaces dropped meetings 11..25 with no trace.
  it('renders every loaded past meeting, not the first ten', () => {
    mocks.pages = [{ items: past(25) }];

    render(<MeetingsContent />);

    expect(screen.getByText('Past meeting 0')).toBeInTheDocument();
    expect(screen.getByText('Past meeting 10')).toBeInTheDocument();
    expect(screen.getByText('Past meeting 24')).toBeInTheDocument();
  });

  // Past's own continuation control, walking Past's own cursor.
  it('offers a way past the page when the server reports more past meetings', () => {
    mocks.upcoming = future(120);
    mocks.pages = [{ items: past(50), nextCursor: 'cursor_1' }];
    mocks.hasNextPage = true;

    render(<MeetingsContent />);

    const continuation = screen.getByText(/more remain/i);
    expect(continuation).toBeInTheDocument();
    // Keep the 170-meeting fixture, but query its pagination controls locally
    // instead of computing accessible names for every meeting-card button.
    const loadMore = within(continuation.parentElement!).getByRole('button', {
      name: /load more/i,
    });

    fireEvent.click(loadMore);
    expect(mocks.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('renders a second past page alongside the first', () => {
    mocks.pages = [
      { items: past(2), nextCursor: 'cursor_1' },
      { items: [meeting('Older meeting', new Date(Date.now() - 40 * HOUR))] },
    ];

    render(<MeetingsContent />);

    expect(screen.getByText('Past meeting 0')).toBeInTheDocument();
    expect(screen.getByText('Older meeting')).toBeInTheDocument();
  });

  it('offers nothing more when the last past page is loaded', () => {
    mocks.upcoming = future(120);
    mocks.pages = [{ items: past(3) }];
    mocks.hasNextPage = false;

    render(<MeetingsContent />);

    expect(screen.getByText('Past meeting 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});

describe('MeetingsContent time order (DEV-249)', () => {
  beforeAll(() => {
    // jsdom has no layout, so it has no `scrollIntoView`; the time picker calls
    // it to keep the highlighted option visible.
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    mocks.upcoming = [];
    mocks.pages = [];
    mocks.hasNextPage = false;
    mocks.errors = {};
    mocks.mutate.create.mockClear();
    mocks.mutate.update.mockClear();
  });

  /** Open a time picker by its accessible name and choose one option. */
  const pick = (picker: 'Start time' | 'End time', option: string) => {
    fireEvent.click(screen.getByRole('button', { name: picker }));
    fireEvent.click(screen.getByRole('option', { name: option }));
  };

  const expectRangeRefused = (submit: HTMLElement) => {
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(MEETING_TIME_ORDER_MESSAGE);
    const end = screen.getByRole('button', { name: 'End time' });
    expect(end).toHaveAttribute('data-invalid', 'true');
    expect(end).toHaveAttribute('aria-describedby', alert.id);
    expect(submit).toBeDisabled();
  };

  const openCreateForm = () => {
    const { container } = render(<MeetingsContent />);
    fireEvent.click(screen.getByRole('button', { name: /schedule meeting/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Sprint Planning'), {
      target: { value: 'Sprint Planning' },
    });
    fireEvent.change(container.querySelector('input[type="date"]')!, {
      target: { value: '2030-01-15' },
    });
    return screen.getByRole('button', { name: 'Schedule' });
  };

  it('blocks creating a meeting that ends before or when it starts', () => {
    const submit = openCreateForm();

    pick('Start time', '10:00 AM');
    pick('End time', '9:00 AM');
    expectRangeRefused(submit);
    fireEvent.click(submit);
    expect(mocks.mutate.create).not.toHaveBeenCalled();

    // Equal is refused too: a zero-length meeting is not a meeting.
    pick('End time', '10:00 AM');
    expectRangeRefused(submit);
    fireEvent.click(submit);
    expect(mocks.mutate.create).not.toHaveBeenCalled();
  });

  it('clears the refusal and submits once the end is after the start', () => {
    const submit = openCreateForm();

    pick('Start time', '10:00 AM');
    pick('End time', '9:00 AM');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    pick('End time', '11:00 AM');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End time' })).not.toHaveAttribute('data-invalid');
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    expect(mocks.mutate.create).toHaveBeenCalledTimes(1);
    const [input] = mocks.mutate.create.mock.calls[0] as [{ startTime: Date; endTime: Date }];
    expect(input.startTime).toEqual(new Date(2030, 0, 15, 10, 0));
    expect(input.endTime).toEqual(new Date(2030, 0, 15, 11, 0));
  });

  it('shows the server’s refusal when the form itself found nothing wrong', () => {
    mocks.errors.create = { message: 'Session expired. Please log out and log back in.' };
    openCreateForm();

    expect(screen.getByRole('alert')).toHaveTextContent('Session expired');
    // Not attributed to the end time: the end time is not what is wrong.
    expect(screen.getByRole('button', { name: 'End time' })).not.toHaveAttribute('data-invalid');
  });

  it('blocks saving an edit that moves the end before the start', () => {
    const start = new Date(2030, 0, 15, 10, 0);
    mocks.upcoming = [meeting('Standup', start)];
    render(<MeetingsContent />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();

    pick('End time', '9:30 AM');
    expectRangeRefused(save);
    fireEvent.click(save);
    expect(mocks.mutate.update).not.toHaveBeenCalled();

    pick('End time', '10:30 AM');
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(mocks.mutate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'Standup',
        startTime: start,
        endTime: new Date(2030, 0, 15, 10, 30),
      })
    );
  });
});
