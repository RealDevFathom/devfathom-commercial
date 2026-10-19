import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HotelJourneyTemplatesPage from '@/app/(app)/hotel/settings/journey/page';
import {
  HOTEL_JOURNEY_CHANNEL_LABELS,
  HOTEL_JOURNEY_LANGUAGE_LABELS,
  HOTEL_JOURNEY_MOMENT_KINDS,
  HOTEL_JOURNEY_MOMENT_LABELS,
  HOTEL_JOURNEY_PLACEHOLDERS,
  HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS,
} from '@/lib/hotel/journey-templates';

import { HotelJourneyTemplatesEditor } from './journey-templates-editor';

type View = ComponentProps<typeof HotelJourneyTemplatesEditor>['initial'];
type Template = View['templates'][number];
type Callbacks = {
  onSuccess: (template: Template) => Promise<void>;
  onError: (error: Error) => void;
};
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  save: vi.fn(),
  approve: vi.fn(),
  retire: vi.fn(),
  list: vi.fn(),
  context: vi.fn(),
  callbacks: {} as Record<'save' | 'approve' | 'retire', Callbacks>,
  pending: false,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ hotelProperty: { journeyTemplates: { list: { fetch: mocks.fetch } } } }),
    hotelProperty: {
      journeyTemplates: {
        save: {
          useMutation: (callbacks: Callbacks) => {
            mocks.callbacks.save = callbacks;
            return { mutate: mocks.save, isPending: mocks.pending };
          },
        },
        approve: {
          useMutation: (callbacks: Callbacks) => {
            mocks.callbacks.approve = callbacks;
            return { mutate: mocks.approve, isPending: false };
          },
        },
        retire: {
          useMutation: (callbacks: Callbacks) => {
            mocks.callbacks.retire = callbacks;
            return { mutate: mocks.retire, isPending: false };
          },
        },
      },
    },
  },
}));
vi.mock('@/server/routers/hotel-property', () => ({
  hotelPropertyRouter: { createCaller: () => ({ journeyTemplates: { list: mocks.list } }) },
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));

const at = new Date('2026-09-13T08:00:00Z');
function row(overrides: Partial<Template> = {}): Template {
  return {
    id: 'original',
    moment: 'WELCOME',
    channel: 'EMAIL',
    language: 'EN',
    subject: 'Welcome to {{property_name}}',
    body: 'Hello {{guest_name}}, room {{room_number}}.',
    version: 1,
    status: 'DRAFT',
    approvedByUserId: null,
    approvedAt: null,
    createdByUserId: 'author',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function view(templates = [row()], canApprove = true): View {
  return {
    templates,
    canApprove,
    quietHours: { startMinute: 1320, endMinute: 420 },
    propertyTimezone: 'Asia/Karachi',
    moments: Object.entries(HOTEL_JOURNEY_MOMENT_LABELS).map(([value, label]) => ({
      value: value as Template['moment'],
      label,
      kind: HOTEL_JOURNEY_MOMENT_KINDS[value as Template['moment']],
      placeholders: HOTEL_JOURNEY_PLACEHOLDERS[value as Template['moment']],
    })),
    channels: Object.entries(HOTEL_JOURNEY_CHANNEL_LABELS).map(([value, label]) => ({
      value: value as Template['channel'],
      label,
    })),
    languages: Object.entries(HOTEL_JOURNEY_LANGUAGE_LABELS).map(([value, label]) => ({
      value: value as Template['language'],
      label,
    })),
    statusLabels: HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS,
  };
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name, exact: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = false;
  mocks.context.mockResolvedValue({});
  mocks.fetch.mockResolvedValue(view());
});
afterEach(cleanup);

describe('guest message draft editing', () => {
  it.each(['APPROVED', 'RETIRED'] as const)(
    'creates an editable replacement of %s copy without changing the original',
    async (status) => {
      const original = Object.freeze(
        row({ status, version: 4, approvedByUserId: 'admin', approvedAt: at })
      );
      render(<HotelJourneyTemplatesEditor initial={view([original])} />);
      expect(screen.getByLabelText('Message')).toHaveAttribute('readonly');
      expect(screen.queryByRole('button', { name: 'Save as a new draft' })).not.toBeInTheDocument();
      click('Create replacement draft');
      expect(mocks.save).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Message')).not.toHaveAttribute('readonly');
      expect(screen.getByLabelText('Subject line')).toHaveValue(original.subject);
      expect(screen.getByLabelText('Message')).toHaveValue(original.body);
      change('Message', 'Updated {{guest_name}}');
      click('View original version');
      expect(screen.getByLabelText('Message')).toHaveValue(original.body);
      click('Create replacement draft');
      expect(screen.getByLabelText('Message')).toHaveValue('Updated {{guest_name}}');
      click('Save as a new draft');
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
        moment: original.moment,
        channel: original.channel,
        language: original.language,
        subject: original.subject,
        body: 'Updated {{guest_name}}',
      });
      const saved = row({ id: 'replacement', version: 5, body: 'Updated {{guest_name}}' });
      mocks.fetch.mockResolvedValue(view([saved, original]));
      await act(() => mocks.callbacks.save.onSuccess(saved));
      expect(screen.getByText(/version 4/)).toBeInTheDocument();
      expect(screen.getByText(/version 5/)).toBeInTheDocument();
      expect(original.body).toBe('Hello {{guest_name}}, room {{room_number}}.');
      expect(original.status).toBe(status);
    }
  );

  it('submits preserved non-empty copy when a replacement is saved without edits', () => {
    const original = row({ status: 'APPROVED' });
    render(<HotelJourneyTemplatesEditor initial={view([original])} />);
    click('Create replacement draft');
    click('Save as a new draft');
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ body: original.body, subject: original.subject })
    );
  });

  it.each([false, true])('creates an Urdu SMS draft with an empty catalog: %s', (empty) => {
    render(<HotelJourneyTemplatesEditor initial={view(empty ? [] : [row()])} />);
    if (!empty) click('New draft');
    expect(within(screen.getByLabelText('Journey moment')).getAllByRole('option')).toHaveLength(8);
    expect(within(screen.getByLabelText('Channel')).getAllByRole('option')).toHaveLength(3);
    expect(within(screen.getByLabelText('Language')).getAllByRole('option')).toHaveLength(2);
    change('Journey moment', 'REVIEW_REQUEST');
    change('Channel', 'SMS');
    change('Language', 'UR');
    expect(screen.getByLabelText('Message')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByText(/Available at this moment/)).toHaveTextContent('{{review_link}}');
    change('Message', 'شکریہ {{guest_name}}۔ {{review_link}}');
    click('Save draft');
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      moment: 'REVIEW_REQUEST',
      channel: 'SMS',
      language: 'UR',
      subject: null,
      body: 'شکریہ {{guest_name}}۔ {{review_link}}',
    });
  });

  it('keeps new-draft copy when changing channel, language and moment', () => {
    render(<HotelJourneyTemplatesEditor initial={view([])} />);
    change('Channel', 'EMAIL');
    change('Subject line', 'My subject');
    change('Message', 'My message');
    change('Channel', 'SMS');
    change('Language', 'UR');
    change('Journey moment', 'INVOICE');
    change('Channel', 'EMAIL');
    expect(screen.getByLabelText('Subject line')).toHaveValue('My subject');
    expect(screen.getByLabelText('Message')).toHaveValue('My message');
  });

  it('preserves text across validation errors and selecting other versions', () => {
    render(
      <HotelJourneyTemplatesEditor initial={view([row(), row({ id: 'second', version: 2 })])} />
    );
    change('Message', 'My {{typo}}');
    click('Save draft');
    act(() =>
      mocks.callbacks.save.onError(
        Object.assign(new Error('Invalid'), {
          data: { validation: { body: ['Unknown placeholder'] } },
        })
      )
    );
    expect(screen.getByLabelText('Message')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown placeholder');
    expect(screen.getByLabelText('Message')).toHaveValue('My {{typo}}');
    fireEvent.click(screen.getByRole('button', { name: /version 2/ }));
    fireEvent.click(screen.getByRole('button', { name: /version 1/ }));
    expect(screen.getByLabelText('Message')).toHaveValue('My {{typo}}');
  });

  it('keeps both subject and body after a mutation failure', () => {
    render(<HotelJourneyTemplatesEditor initial={view()} />);
    change('Subject line', 'Edited subject');
    change('Message', 'Edited body');
    click('Save draft');
    act(() => mocks.callbacks.save.onError(new Error('Save unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Save unavailable');
    expect(screen.getByLabelText('Subject line')).toHaveValue('Edited subject');
    expect(screen.getByLabelText('Message')).toHaveValue('Edited body');
  });

  it('exposes refresh failure after a successful save and recovers without dropping text', async () => {
    render(<HotelJourneyTemplatesEditor initial={view()} />);
    change('Message', 'Saved body');
    click('Save draft');
    const saved = row({ body: 'Saved body' });
    mocks.fetch.mockRejectedValueOnce(new Error('Offline'));
    await act(() => mocks.callbacks.save.onSuccess(saved));
    expect(screen.getByRole('alert')).toHaveTextContent('could not be refreshed');
    expect(screen.getByLabelText('Message')).toHaveValue('Saved body');
    expect(screen.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
    change('Message', 'Further unsaved edits');
    mocks.fetch.mockResolvedValue(view([saved]));
    click('Retry refresh');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Message')).toHaveValue('Further unsaved edits');
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  });

  it('disables navigation and writes while refreshing after a save', async () => {
    let finish!: (value: View) => void;
    mocks.fetch.mockReturnValue(
      new Promise<View>((resolve) => {
        finish = resolve;
      })
    );
    render(<HotelJourneyTemplatesEditor initial={view()} />);
    let completion!: Promise<void>;
    act(() => {
      completion = mocks.callbacks.save.onSuccess(row());
    });
    expect(screen.getByText('Refreshing message list…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New draft' })).toBeDisabled();
    expect(screen.getByLabelText('Message')).toBeDisabled();
    await act(async () => {
      finish(view());
      await completion;
    });
    expect(screen.getByLabelText('Message')).not.toBeDisabled();
  });

  it('keeps approval separate from unsaved copy and hides it from marketing', () => {
    const { unmount } = render(<HotelJourneyTemplatesEditor initial={view()} />);
    change('Message', 'Unsaved');
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retire', exact: true })).toBeDisabled();
    expect(mocks.approve).not.toHaveBeenCalled();
    unmount();
    render(<HotelJourneyTemplatesEditor initial={view([row()], false)} />);
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retire', exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
  });

  it('shows approved read-only copy after approval even when the list refresh fails', async () => {
    render(<HotelJourneyTemplatesEditor initial={view()} />);
    click('Approve');
    expect(mocks.approve).toHaveBeenCalledExactlyOnceWith({ id: 'original' });
    mocks.fetch.mockRejectedValueOnce(new Error('Offline'));
    await act(() =>
      mocks.callbacks.approve.onSuccess(
        row({ status: 'APPROVED', approvedAt: at, approvedByUserId: 'admin' })
      )
    );
    expect(screen.getByLabelText('Message')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('could not be refreshed');
  });
});

describe('guest message review corrections', () => {
  it.each(['save', 'approve', 'retire'] as const)(
    'announces a status refusal from %s without losing the displayed copy',
    (action) => {
      const original = row();
      render(<HotelJourneyTemplatesEditor initial={view([original])} />);
      click(action === 'save' ? 'Save draft' : action === 'approve' ? 'Approve' : 'Retire');
      act(() =>
        mocks.callbacks[action].onError(
          Object.assign(new Error('Invalid transition'), {
            data: { validation: { status: ['This version was retired.'] } },
          })
        )
      );
      expect(screen.getByRole('alert')).toHaveTextContent('This version was retired.');
      expect(screen.getByLabelText('Subject line')).toHaveValue(original.subject);
      expect(screen.getByLabelText('Message')).toHaveValue(original.body);
    }
  );

  it('announces unrendered refusals alongside a visible body error', () => {
    render(
      <HotelJourneyTemplatesEditor initial={view([row({ channel: 'SMS', subject: null })])} />
    );
    change('Message', 'Kept text');
    click('Save draft');
    act(() =>
      mocks.callbacks.save.onError(
        Object.assign(new Error('Invalid'), {
          data: {
            validation: {
              body: ['Unknown placeholder'],
              subject: ['Subject is not allowed.'],
              context: ['Context is missing.'],
            },
          },
        })
      )
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent('Unknown placeholder');
    expect(alerts[1]).toHaveTextContent('Subject is not allowed. Context is missing.');
    expect(screen.getByLabelText('Message')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Message')).toHaveValue('Kept text');
  });

  it('falls back to the mutation error when validation contains no messages', () => {
    render(<HotelJourneyTemplatesEditor initial={view()} />);
    click('Approve');
    act(() =>
      mocks.callbacks.approve.onError(
        Object.assign(new Error('Approval unavailable'), {
          data: { validation: { status: [] } },
        })
      )
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Approval unavailable');
  });

  it.each(['APPROVED', 'RETIRED'] as const)(
    'opens the matching draft from %s copy and saves its kept buffer',
    (status) => {
      const original = Object.freeze(row({ status, version: 4 }));
      const draft = row({ id: 'draft', version: 5, body: 'Draft body' });
      const other = row({ id: 'other', version: 6, language: 'UR', body: 'Other language' });
      render(<HotelJourneyTemplatesEditor initial={view([original, other, draft])} />);
      expect(screen.getByText(/Draft version 5 already exists/)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Create replacement draft' })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save as a new draft' })).not.toBeInTheDocument();
      click('Open draft version 5');
      change('Subject line', 'Kept draft subject');
      change('Message', 'Kept unsaved draft body');
      fireEvent.click(screen.getByRole('button', { name: /version 4/ }));
      expect(screen.getByLabelText('Message')).toHaveValue(original.body);
      click('Open draft version 5');
      expect(mocks.save).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Subject line')).toHaveValue('Kept draft subject');
      expect(screen.getByLabelText('Message')).toHaveValue('Kept unsaved draft body');
      expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
      click('Save draft');
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
        moment: draft.moment,
        channel: draft.channel,
        language: draft.language,
        subject: 'Kept draft subject',
        body: 'Kept unsaved draft body',
      });
      expect(original.body).toBe('Hello {{guest_name}}, room {{room_number}}.');
      expect(draft.body).toBe('Draft body');
      expect(other.body).toBe('Other language');
    }
  );

  it('recovers the Urdu EMAIL key and unsaved text after an earlier SMS English new draft', async () => {
    const original = row({ language: 'UR', subject: 'خوش آمدید', body: 'سلام {{guest_name}}' });
    render(<HotelJourneyTemplatesEditor initial={view([original])} />);
    click('New draft');
    change('Journey moment', 'REVIEW_REQUEST');
    change('Channel', 'SMS');
    change('Language', 'EN');
    change('Message', 'Earlier new draft');
    fireEvent.click(screen.getByRole('button', { name: /version 1/ }));
    click('Save draft');
    mocks.fetch.mockRejectedValueOnce(new Error('Offline'));
    await act(() => mocks.callbacks.save.onSuccess(original));
    change('Subject line', 'محفوظ عنوان');
    change('Message', 'محفوظ پیغام {{guest_name}}');
    mocks.fetch.mockResolvedValue(view([]));
    click('Retry refresh');
    await screen.findByRole('heading', { name: 'This version is no longer available' });
    click('Use kept text in a new draft');
    expect(screen.getByLabelText('Journey moment')).toHaveValue('WELCOME');
    expect(screen.getByLabelText('Channel')).toHaveValue('EMAIL');
    expect(screen.getByLabelText('Language')).toHaveValue('UR');
    expect(screen.getByLabelText('Subject line')).toHaveValue('محفوظ عنوان');
    expect(screen.getByLabelText('Subject line')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByLabelText('Message')).toHaveValue('محفوظ پیغام {{guest_name}}');
    expect(screen.getByLabelText('Message')).toHaveAttribute('dir', 'rtl');
    click('Save draft');
    expect(mocks.save).toHaveBeenLastCalledWith({
      moment: 'WELCOME',
      channel: 'EMAIL',
      language: 'UR',
      subject: 'محفوظ عنوان',
      body: 'محفوظ پیغام {{guest_name}}',
    });
  });

  it('retains an unedited version and its key before a refresh omits it', async () => {
    const original = row({ language: 'UR', subject: 'خوش آمدید', body: 'سلام {{guest_name}}' });
    render(<HotelJourneyTemplatesEditor initial={view([original])} />);
    click('Approve');
    mocks.fetch.mockResolvedValue(view([]));
    await act(() => mocks.callbacks.approve.onSuccess(row({ ...original, status: 'APPROVED' })));
    click('Use kept text in a new draft');
    expect(screen.getByLabelText('Language')).toHaveValue('UR');
    expect(screen.getByLabelText('Subject line')).toHaveValue(original.subject);
    expect(screen.getByLabelText('Message')).toHaveValue(original.body);
    click('Save draft');
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      moment: original.moment,
      channel: original.channel,
      language: original.language,
      subject: original.subject,
      body: original.body,
    });
  });
});

describe('guest messages page error states', () => {
  it.each([
    ['FORBIDDEN', 'This page is not available to you', false],
    ['UNAUTHORIZED', 'Sign in to view guest messages', true],
    ['NOT_FOUND', 'No hospitality property is available', false],
    ['INTERNAL_SERVER_ERROR', 'Guest messages could not be loaded', true],
  ] as const)('explains %s without leaking server details', async (code, heading, retry) => {
    mocks.list.mockRejectedValueOnce(
      new TRPCError({ code, message: 'private connection details' })
    );
    render(await HotelJourneyTemplatesPage());
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.queryByText('private connection details')).not.toBeInTheDocument();
    expect(!!screen.queryByRole('link', { name: 'Reload guest messages' })).toBe(retry);
  });

  it('renders the editable empty state after a successful load', async () => {
    mocks.list.mockResolvedValueOnce(view([]));
    render(await HotelJourneyTemplatesPage());
    expect(screen.getByRole('heading', { name: 'Create a guest message' })).toBeInTheDocument();
  });

  it('preserves framework control-flow errors from context creation', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/login;307;',
    });
    mocks.context.mockRejectedValueOnce(redirect);
    await expect(HotelJourneyTemplatesPage()).rejects.toBe(redirect);
  });
});
