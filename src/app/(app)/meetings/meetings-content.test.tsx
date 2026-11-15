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
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
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
  upcoming: [] as unknown[],
  pages: [] as Array<{ items: unknown[]; nextCursor?: string }>,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
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
        create: { useMutation: () => ({ mutate: mocks.create, isPending: false }) },
        update: { useMutation: () => ({ mutate: mocks.update, isPending: false }) },
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

describe('meeting form time order', () => {
  beforeEach(() => {
    mocks.upcoming = [];
    mocks.pages = [];
    mocks.hasNextPage = false;
    mocks.create.mockClear();
    mocks.update.mockClear();
    // jsdom has no layout or scrolling API. Keep the real TimePicker interaction.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  function chooseTime(label: string, option: string) {
    fireEvent.click(screen.getByRole('button', { name: label }));
    fireEvent.click(screen.getByRole('option', { name: option }));
  }

  it.each(['9:00 AM', '10:00 AM'])(
    'blocks creating a meeting ending at %s and allows correction',
    (endLabel) => {
      const { container } = render(<MeetingsContent />);
      fireEvent.click(screen.getByRole('button', { name: /schedule meeting/i }));
      fireEvent.change(screen.getByPlaceholderText('e.g. Sprint Planning'), {
        target: { value: 'Planning' },
      });
      fireEvent.change(container.querySelector('input[type="date"]')!, {
        target: { value: '2026-12-01' },
      });
      chooseTime('Start time', '10:00 AM');
      chooseTime('End time', endLabel);
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The end time must be after the start time.'
      );
      expect(screen.getByRole('group', { name: 'Meeting times' })).toHaveAccessibleDescription(
        'The end time must be after the start time.'
      );
      const create = screen.getByRole('button', { name: /^schedule$/i });
      expect(create).toBeDisabled();
      fireEvent.click(create);
      expect(mocks.create).not.toHaveBeenCalled();
      chooseTime('End time', '11:00 AM');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(create).toBeEnabled();
      fireEvent.click(create);
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          startTime: new Date('2026-12-01T10:00'),
          endTime: new Date('2026-12-01T11:00'),
        })
      );
    }
  );

  it.each(['9:00 AM', '10:00 AM'])(
    'blocks saving an edit ending at %s and allows correction',
    (endLabel) => {
      mocks.upcoming = [
        { ...meeting('Planning', new Date('2026-12-01T10:00')), createdById: 'user_1' },
      ];
      render(<MeetingsContent />);
      fireEvent.click(screen.getByTitle('Edit'));
      chooseTime('End time', endLabel);
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The end time must be after the start time.'
      );
      expect(screen.getByRole('group', { name: 'Meeting times' })).toHaveAccessibleDescription(
        'The end time must be after the start time.'
      );
      const save = screen.getByRole('button', { name: /save/i });
      expect(save).toBeDisabled();
      fireEvent.click(save);
      expect(mocks.update).not.toHaveBeenCalled();
      chooseTime('End time', '11:00 AM');
      expect(save).toBeEnabled();
      fireEvent.click(save);
      expect(mocks.update).toHaveBeenCalledOnce();
    }
  );
});
