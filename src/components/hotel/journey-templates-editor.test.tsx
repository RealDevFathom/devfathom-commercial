import { selectFieldControl } from '@/lib/testing/select-field';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOTEL_JOURNEY_CHANNEL_LABELS,
  HOTEL_JOURNEY_LANGUAGE_LABELS,
  HOTEL_JOURNEY_MOMENT_KINDS,
  HOTEL_JOURNEY_MOMENT_LABELS,
  HOTEL_JOURNEY_PLACEHOLDERS,
  HOTEL_JOURNEY_TEMPLATE_STATUS_LABELS,
} from '@/lib/hotel/journey-templates';

import {
  HotelJourneyTemplatesEditor,
  minutesToClock,
  placeholdersIn,
  sampleValueFor,
} from './journey-templates-editor';

type View = ComponentProps<typeof HotelJourneyTemplatesEditor>['initial'];
type Template = View['templates'][number];
type Callbacks = {
  onSuccess: (template: Template) => Promise<void>;
  onError: (error: Error) => void;
};
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  preview: vi.fn(),
  save: vi.fn(),
  approve: vi.fn(),
  retire: vi.fn(),
  callbacks: {} as Record<'save' | 'approve' | 'retire', Callbacks>,
  pending: false,
  session: { user: { id: 'user', organizationId: 'org' } },
}));

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: mocks.session }) }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      hotelProperty: {
        journeyTemplates: { list: { fetch: mocks.fetch }, preview: { fetch: mocks.preview } },
      },
    }),
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

const selection = { branchId: 'branch', organizationId: 'org', userId: 'user' };
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
    branchId: 'branch',
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

const mount = (initial = view()) =>
  render(<HotelJourneyTemplatesEditor initial={initial} selection={selection} />);
function change(label: string, value: string) {
  fireEvent.change(
    selectFieldControl(
      screen.getByLabelText(label, {
        selector: ':not([data-select-field-native][aria-hidden="true"])',
      })
    ),
    { target: { value } }
  );
}
function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}
const refused = (code: string, validation?: Record<string, string[]>, message = 'Refused') =>
  Object.assign(new Error(message), { data: { code, validation } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pending = false;
  mocks.session = { user: { id: 'user', organizationId: 'org' } };
  mocks.fetch.mockResolvedValue(view());
});
afterEach(cleanup);

describe('guest message helpers', () => {
  it('reads a clock, the placeholders a copy names and a sample for each', () => {
    expect(minutesToClock(1320)).toBe('22:00');
    expect(minutesToClock(5)).toBe('00:05');
    expect(
      placeholdersIn('Hi {{ guest_name }}, room {{room_number}} {{guest_name}} {{broken')
    ).toEqual(['guest_name', 'room_number']);
    expect(sampleValueFor('guest_name')).toBe('Sara Khan');
    expect(sampleValueFor('late_checkout_fee')).toBe('Sample late checkout fee');
  });
});

describe('guest message board', () => {
  it('names moments, channels, languages and statuses for an operator and never prints a stored key', () => {
    mount(
      view([
        row(),
        row({
          id: 'approved',
          status: 'APPROVED',
          version: 2,
          approvedByUserId: 'admin',
          approvedAt: at,
        }),
        row({ id: 'sms', channel: 'SMS', language: 'UR', subject: null, moment: 'REVIEW_REQUEST' }),
      ])
    );
    const board = screen
      .getByRole('heading', { level: 2, name: 'Guest messages (3)' })
      .closest<HTMLElement>('[data-slot="section-card"]')!;
    expect(
      within(board).getByText('1 approved · 2 in draft.', { exact: false })
    ).toBeInTheDocument();
    expect(within(board).getAllByText('Welcome')).toHaveLength(2);
    expect(within(board).getByText('Review request')).toBeInTheDocument();
    expect(within(board).getAllByText('E-mail')).toHaveLength(2);
    expect(within(board).getByText('SMS')).toBeInTheDocument();
    expect(within(board).getByText('Urdu')).toBeInTheDocument();
    expect(within(board).getAllByText('Draft')).toHaveLength(2);
    expect(within(board).getByText('Approved')).toBeInTheDocument();
    expect(board.textContent).not.toMatch(/WELCOME|EMAIL|REVIEW_REQUEST|DRAFT|APPROVED\b/);
    // The first version opens by default and says so.
    expect(within(board).getByRole('button', { name: /^Opened/ })).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(
      screen.getByText(/Offers and review requests are held between 22:00 and 07:00/)
    ).toHaveTextContent('Asia/Karachi');
  });

  it('reloads on an identity change instead of writing under the old selection', () => {
    mocks.session = { user: { id: 'someone-else', organizationId: 'org' } };
    mount();
    expect(screen.getByRole('heading', { name: 'Reload the guest messages' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a property' })).toHaveAttribute(
      'href',
      '/hotel/settings/journey'
    );
  });

  it('refreshes past the cache with the selection and rechecks revoked access', async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh messages' }));
    });
    expect(mocks.fetch).toHaveBeenCalledWith({ branchId: 'branch' }, { staleTime: 0 });
    mocks.fetch.mockRejectedValueOnce(refused('FORBIDDEN'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh messages' }));
    });
    expect(screen.getByRole('heading', { name: 'Choose a property again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a property' })).toHaveAttribute(
      'href',
      '/hotel/settings/journey'
    );
  });

  it('takes no focus when it mounts', () => {
    mount();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('guest message draft editing', () => {
  it.each(['APPROVED', 'RETIRED'] as const)(
    'creates an editable replacement of %s copy without changing the original',
    async (status) => {
      const original = Object.freeze(
        row({ status, version: 4, approvedByUserId: 'admin', approvedAt: at })
      );
      mount(view([original]));
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
        branchId: 'branch',
        moment: original.moment,
        channel: original.channel,
        language: original.language,
        subject: original.subject,
        body: 'Updated {{guest_name}}',
      });
      const saved = row({ id: 'replacement', version: 5, body: 'Updated {{guest_name}}' });
      mocks.fetch.mockResolvedValue(view([saved, original]));
      await act(() => mocks.callbacks.save.onSuccess(saved));
      expect(screen.getByRole('button', { name: /version 4/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /version 5/ })).toBeInTheDocument();
      expect(original.body).toBe('Hello {{guest_name}}, room {{room_number}}.');
      expect(original.status).toBe(status);
    }
  );

  it('submits preserved non-empty copy when a replacement is saved without edits', () => {
    const original = row({ status: 'APPROVED', approvedByUserId: 'admin', approvedAt: at });
    mount(view([original]));
    click('Create replacement draft');
    click('Save as a new draft');
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch',
        body: original.body,
        subject: original.subject,
      })
    );
  });

  it.each([false, true])('creates an Urdu SMS draft with an empty catalog: %s', (empty) => {
    mount(view(empty ? [] : [row()]));
    if (!empty) click('New draft');
    expect(
      within(
        selectFieldControl(
          screen.getByLabelText('Journey moment', {
            selector: ':not([data-select-field-native][aria-hidden="true"])',
          })
        )
      ).getAllByRole('option', { hidden: true })
    ).toHaveLength(8);
    expect(
      within(
        selectFieldControl(
          screen.getByLabelText('Channel', {
            selector: ':not([data-select-field-native][aria-hidden="true"])',
          })
        )
      ).getAllByRole('option', { hidden: true })
    ).toHaveLength(3);
    expect(
      within(
        selectFieldControl(
          screen.getByLabelText('Language', {
            selector: ':not([data-select-field-native][aria-hidden="true"])',
          })
        )
      ).getAllByRole('option', { hidden: true })
    ).toHaveLength(2);
    change('Journey moment', 'REVIEW_REQUEST');
    change('Channel', 'SMS');
    change('Language', 'UR');
    expect(screen.getByLabelText('Message')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByText(/Available at this moment/)).toHaveTextContent('{{review_link}}');
    change('Message', 'شکریہ {{guest_name}}۔ {{review_link}}');
    click('Save draft');
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch',
      moment: 'REVIEW_REQUEST',
      channel: 'SMS',
      language: 'UR',
      subject: null,
      body: 'شکریہ {{guest_name}}۔ {{review_link}}',
    });
  });

  it('keeps new-draft copy when changing channel, language and moment', () => {
    mount(view([]));
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
    mount(view([row(), row({ id: 'second', version: 2 })]));
    change('Message', 'My {{typo}}');
    click('Save draft');
    act(() =>
      mocks.callbacks.save.onError(refused('BAD_REQUEST', { body: ['Unknown placeholder'] }))
    );
    expect(screen.getByLabelText('Message')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown placeholder');
    expect(screen.getByLabelText('Message')).toHaveValue('My {{typo}}');
    fireEvent.click(screen.getByRole('button', { name: /version 2/ }));
    fireEvent.click(screen.getByRole('button', { name: /version 1/ }));
    expect(screen.getByLabelText('Message')).toHaveValue('My {{typo}}');
  });

  it('keeps both subject and body after a mutation failure, and says a conflict kept them', async () => {
    mount();
    change('Subject line', 'Edited subject');
    change('Message', 'Edited body');
    click('Save draft');
    act(() => mocks.callbacks.save.onError(new Error('Save unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Save unavailable');
    expect(screen.getByLabelText('Subject line')).toHaveValue('Edited subject');
    expect(screen.getByLabelText('Message')).toHaveValue('Edited body');
    expect(mocks.fetch).not.toHaveBeenCalled();
    await act(async () =>
      mocks.callbacks.save.onError(
        refused('CONFLICT', undefined, 'This message changed while you were working.')
      )
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This message changed while you were working. Your editor text has been kept.'
    );
    expect(screen.getByLabelText('Message')).toHaveValue('Edited body');
    // A conflict means the list is out of date: it is reloaded past the cache.
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' }, { staleTime: 0 });
  });

  it('exposes refresh failure after a successful save and recovers without dropping text', async () => {
    mount();
    change('Message', 'Saved body');
    click('Save draft');
    const saved = row({ body: 'Saved body' });
    mocks.fetch.mockRejectedValueOnce(new Error('Offline'));
    await act(() => mocks.callbacks.save.onSuccess(saved));
    expect(screen.getByRole('alert')).toHaveTextContent('could not be refreshed');
    expect(screen.getByLabelText('Message')).toHaveValue('Saved body');
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    change('Message', 'Further unsaved edits');
    mocks.fetch.mockResolvedValue(view([saved]));
    click('Retry refresh');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Message')).toHaveValue('Further unsaved edits');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('disables navigation and writes while refreshing after a save', async () => {
    let finish!: (value: View) => void;
    mocks.fetch.mockReturnValue(
      new Promise<View>((resolve) => {
        finish = resolve;
      })
    );
    mount();
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
    const { unmount } = mount();
    change('Message', 'Unsaved');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retire' })).toBeDisabled();
    expect(mocks.approve).not.toHaveBeenCalled();
    unmount();
    mount(view([row()], false));
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retire' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    expect(screen.getByText(/Approving one is the property administrator/)).toBeInTheDocument();
  });

  it('approves and retires with the selection, and shows approved read-only copy even when the refresh fails', async () => {
    mount();
    click('Approve');
    expect(mocks.approve).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch',
      id: 'original',
      expectedUpdatedAt: at,
      expectedSubject: 'Welcome to {{property_name}}',
      expectedBody: 'Hello {{guest_name}}, room {{room_number}}.',
      expectedApprovedId: null,
    });
    mocks.fetch.mockRejectedValueOnce(new Error('Offline'));
    await act(() =>
      mocks.callbacks.approve.onSuccess(
        row({ status: 'APPROVED', approvedAt: at, approvedByUserId: 'admin' })
      )
    );
    expect(screen.getByLabelText('Message')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('could not be refreshed');
    mocks.fetch.mockResolvedValue(
      view([row({ status: 'APPROVED', approvedAt: at, approvedByUserId: 'admin' })])
    );
    click('Retry refresh');
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retire' })).toBeEnabled());
    click('Retire');
    expect(mocks.retire).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch',
      id: 'original',
      expectedUpdatedAt: at,
    });
  });

  it('retires a draft naming the words on screen as well as the version', () => {
    mount(view([row({ channel: 'WHATSAPP', subject: null })]));
    click('Retire');
    expect(mocks.retire).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch',
      id: 'original',
      expectedUpdatedAt: at,
      expectedSubject: null,
      expectedBody: 'Hello {{guest_name}}, room {{room_number}}.',
    });
  });

  it('sends the operator back to the chooser when a write is refused for access', () => {
    mount();
    click('Approve');
    act(() => mocks.callbacks.approve.onError(refused('FORBIDDEN')));
    expect(screen.getByRole('heading', { name: 'Choose a property again' })).toBeInTheDocument();
  });
});

describe('guest message review corrections', () => {
  it.each(['save', 'approve', 'retire'] as const)(
    'announces a status refusal from %s without losing the displayed copy',
    (action) => {
      const original = row();
      mount(view([original]));
      click(action === 'save' ? 'Save draft' : action === 'approve' ? 'Approve' : 'Retire');
      act(() =>
        mocks.callbacks[action].onError(
          refused('BAD_REQUEST', { status: ['This version was retired.'] })
        )
      );
      expect(screen.getByRole('alert')).toHaveTextContent('This version was retired.');
      expect(screen.getByLabelText('Subject line')).toHaveValue(original.subject);
      expect(screen.getByLabelText('Message')).toHaveValue(original.body);
    }
  );

  it('announces unrendered refusals alongside a visible body error', () => {
    mount(view([row({ channel: 'SMS', subject: null })]));
    change('Message', 'Kept text');
    click('Save draft');
    act(() =>
      mocks.callbacks.save.onError(
        refused('BAD_REQUEST', {
          body: ['Unknown placeholder'],
          subject: ['Subject is not allowed.'],
          context: ['Context is missing.'],
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
    mount();
    click('Approve');
    act(() =>
      mocks.callbacks.approve.onError(
        refused('INTERNAL_SERVER_ERROR', { status: [] }, 'Approval unavailable')
      )
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Approval unavailable');
  });

  it.each(['APPROVED', 'RETIRED'] as const)(
    'opens the matching draft from %s copy and saves its kept buffer',
    (status) => {
      const original = Object.freeze(
        row({ status, version: 4, approvedByUserId: 'admin', approvedAt: at })
      );
      const draft = row({ id: 'draft', version: 5, body: 'Draft body' });
      const other = row({ id: 'other', version: 6, language: 'UR', body: 'Other language' });
      mount(view([original, other, draft]));
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
      expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
      click('Save draft');
      expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
        branchId: 'branch',
        moment: draft.moment,
        channel: draft.channel,
        language: draft.language,
        subject: 'Kept draft subject',
        body: 'Kept unsaved draft body',
        // The draft version the kept text was started from.
        expectedUpdatedAt: at,
        expectedSubject: draft.subject,
        expectedBody: 'Draft body',
      });
      expect(original.body).toBe('Hello {{guest_name}}, room {{room_number}}.');
      expect(draft.body).toBe('Draft body');
      expect(other.body).toBe('Other language');
    }
  );

  it('recovers the Urdu EMAIL key and unsaved text after an earlier SMS English new draft', async () => {
    const original = row({ language: 'UR', subject: 'خوش آمدید', body: 'سلام {{guest_name}}' });
    mount(view([original]));
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
    expect(
      selectFieldControl(
        screen.getByLabelText('Journey moment', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('WELCOME');
    expect(
      selectFieldControl(
        screen.getByLabelText('Channel', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('EMAIL');
    expect(
      selectFieldControl(
        screen.getByLabelText('Language', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('UR');
    expect(screen.getByLabelText('Subject line')).toHaveValue('محفوظ عنوان');
    expect(screen.getByLabelText('Subject line')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByLabelText('Message')).toHaveValue('محفوظ پیغام {{guest_name}}');
    expect(screen.getByLabelText('Message')).toHaveAttribute('dir', 'rtl');
    click('Save draft');
    expect(mocks.save).toHaveBeenLastCalledWith({
      branchId: 'branch',
      moment: 'WELCOME',
      channel: 'EMAIL',
      language: 'UR',
      subject: 'محفوظ عنوان',
      body: 'محفوظ پیغام {{guest_name}}',
    });
  });

  it('retains an unedited version and its key before a refresh omits it', async () => {
    const original = row({ language: 'UR', subject: 'خوش آمدید', body: 'سلام {{guest_name}}' });
    mount(view([original]));
    click('Approve');
    mocks.fetch.mockResolvedValue(view([]));
    await act(() => mocks.callbacks.approve.onSuccess(row({ ...original, status: 'APPROVED' })));
    click('Use kept text in a new draft');
    expect(
      selectFieldControl(
        screen.getByLabelText('Language', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('UR');
    expect(screen.getByLabelText('Subject line')).toHaveValue(original.subject);
    expect(screen.getByLabelText('Message')).toHaveValue(original.body);
    click('Save draft');
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch',
      moment: original.moment,
      channel: original.channel,
      language: original.language,
      subject: original.subject,
      body: original.body,
    });
  });
});

describe('guest message writes name the version the page read', () => {
  const later = new Date('2026-09-13T09:30:00Z');
  const CHANGED =
    'This message changed while you were working. Reload the current version before trying again.';
  const savedRegion = () => screen.queryByRole('region', { name: /Saved wording/ });

  it('sends the draft version it rendered with an edit, and nothing with a new draft', () => {
    const original = row();
    mount(view([original]));
    change('Message', 'Edited {{guest_name}}');
    click('Save draft');
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch',
      moment: 'WELCOME',
      channel: 'EMAIL',
      language: 'EN',
      subject: original.subject,
      body: 'Edited {{guest_name}}',
      expectedUpdatedAt: at,
      expectedSubject: original.subject,
      expectedBody: original.body,
    });
    click('New draft');
    change('Journey moment', 'INVOICE');
    change('Channel', 'SMS');
    change('Message', 'Invoice {{invoice_number}}');
    click('Save draft');
    expect(mocks.save).toHaveBeenLastCalledWith({
      branchId: 'branch',
      moment: 'INVOICE',
      channel: 'SMS',
      language: 'EN',
      subject: null,
      body: 'Invoice {{invoice_number}}',
    });
  });

  it('names the approval it retires along with the version and the wording on screen', () => {
    const standing = row({
      id: 'approved',
      status: 'APPROVED',
      version: 1,
      approvedByUserId: 'admin',
      approvedAt: at,
    });
    const next = row({ id: 'next', version: 2, body: 'Next {{guest_name}}', updatedAt: later });
    const otherLanguage = row({ id: 'ur', language: 'UR', status: 'APPROVED', approvedAt: at });
    mount(view([standing, otherLanguage, next]));
    fireEvent.click(screen.getByRole('button', { name: /English version 2/ }));
    click('Approve');
    expect(mocks.approve).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch',
      id: 'next',
      expectedUpdatedAt: later,
      expectedSubject: next.subject,
      expectedBody: 'Next {{guest_name}}',
      expectedApprovedId: 'approved',
    });
  });

  it.each(['Keep my text', 'Use the saved wording'] as const)(
    'keeps the version typed text started from across a refresh, shows the saved wording, and lets the operator choose: %s',
    async (choice) => {
      mount(view([row()]));
      change('Message', 'My edit {{guest_name}}');
      // A colleague saves the draft; this page learns of it on a refresh.
      mocks.fetch.mockResolvedValue(
        view([row({ body: 'Colleague {{guest_name}}', updatedAt: later })])
      );
      await act(async () => {
        click('Refresh messages');
      });
      const saved = savedRegion();
      expect(saved).toBeInTheDocument();
      expect(within(saved!).getByText('Colleague {{guest_name}}')).toBeInTheDocument();
      expect(screen.getByLabelText('Message')).toHaveValue('My edit {{guest_name}}');
      // Saving over words this page never showed is not offered.
      expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
      fireEvent.submit(screen.getByRole('form', { name: 'Guest message' }));
      expect(mocks.save).not.toHaveBeenCalled();

      click(choice);
      expect(savedRegion()).not.toBeInTheDocument();
      if (choice === 'Keep my text') {
        expect(screen.getByLabelText('Message')).toHaveValue('My edit {{guest_name}}');
        click('Save draft');
        expect(mocks.save).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            body: 'My edit {{guest_name}}',
            expectedUpdatedAt: later,
            expectedBody: 'Colleague {{guest_name}}',
          })
        );
      } else {
        expect(screen.getByLabelText('Message')).toHaveValue('Colleague {{guest_name}}');
        click('Approve');
        expect(mocks.approve).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            expectedUpdatedAt: later,
            expectedBody: 'Colleague {{guest_name}}',
          })
        );
      }
    }
  );

  it('on a save conflict keeps the text, reloads the list and shows the saved wording beside it', async () => {
    mount(view([row()]));
    change('Message', 'My edit {{guest_name}}');
    click('Save draft');
    mocks.fetch.mockResolvedValue(
      view([row({ body: 'Colleague {{guest_name}}', updatedAt: later })])
    );
    await act(async () => mocks.callbacks.save.onError(refused('CONFLICT', undefined, CHANGED)));
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' }, { staleTime: 0 });
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(
      `${CHANGED} Your editor text has been kept.`
    );
    expect(screen.getByLabelText('Message')).toHaveValue('My edit {{guest_name}}');
    expect(within(savedRegion()!).getByText('Colleague {{guest_name}}')).toBeInTheDocument();
  });

  it('on an approval conflict says nothing was approved, reloads, and shows the current wording before approving again', async () => {
    const original = row();
    mount(view([original]));
    // Typed and put back: nothing of the operator's to keep.
    change('Message', 'Briefly changed');
    change('Message', original.body);
    click('Approve');
    expect(mocks.approve).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedUpdatedAt: at, expectedBody: original.body })
    );
    mocks.fetch.mockResolvedValue(
      view([row({ body: 'Changed {{guest_name}}', updatedAt: later })])
    );
    await act(async () => mocks.callbacks.approve.onError(refused('CONFLICT', undefined, CHANGED)));
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' }, { staleTime: 0 });
    expect(screen.getByRole('alert')).toHaveTextContent(
      `${CHANGED} Nothing was approved. Read the current wording before approving it.`
    );
    // The words now shown are the stored ones, not the ones approved a moment ago.
    expect(screen.getByLabelText('Message')).toHaveValue('Changed {{guest_name}}');
    expect(savedRegion()).not.toBeInTheDocument();
    click('Approve');
    expect(mocks.approve).toHaveBeenLastCalledWith({
      branchId: 'branch',
      id: 'original',
      expectedUpdatedAt: later,
      expectedSubject: original.subject,
      expectedBody: 'Changed {{guest_name}}',
      expectedApprovedId: null,
    });
  });

  it('on a retirement conflict says nothing was retired and reloads the list', async () => {
    mount(view([row()]));
    click('Retire');
    mocks.fetch.mockResolvedValue(
      view([
        row({ status: 'APPROVED', approvedByUserId: 'admin', approvedAt: later, updatedAt: later }),
      ])
    );
    await act(async () => mocks.callbacks.retire.onError(refused('CONFLICT', undefined, CHANGED)));
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch' }, { staleTime: 0 });
    expect(screen.getByRole('alert')).toHaveTextContent(
      `${CHANGED} Nothing was retired. Check the current version before retiring it.`
    );
    expect(screen.getByRole('button', { name: /Opened/ })).toBeInTheDocument();
    expect(screen.getByText('Approved · version 1')).toBeInTheDocument();
    click('Retire');
    expect(mocks.retire).toHaveBeenLastCalledWith({
      branchId: 'branch',
      id: 'original',
      expectedUpdatedAt: later,
    });
  });

  it('opens the existing draft instead of saving a new draft over its words', () => {
    const existing = row({ body: 'Existing draft {{guest_name}}' });
    mount(view([existing]));
    click('New draft');
    change('Journey moment', 'WELCOME');
    change('Channel', 'EMAIL');
    change('Language', 'EN');
    change('Message', 'Written without reading the draft');
    expect(
      screen.getByText(/Draft version 1 already exists for this moment, channel and language/)
    ).toHaveTextContent('Open it to read and change its wording.');
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('form', { name: 'Guest message' }));
    expect(mocks.save).not.toHaveBeenCalled();
    // Submitting opened the draft, where its own words are on screen.
    expect(screen.getByLabelText('Message')).toHaveValue('Existing draft {{guest_name}}');
    expect(screen.getByRole('button', { name: /^Opened/ })).toHaveAttribute('aria-current', 'true');
  });
});

describe('guest message preview', () => {
  it('offers a sample value for every placeholder the stored version names and renders it in place', async () => {
    const original = row({
      language: 'UR',
      subject: '{{property_name}} میں خوش آمدید',
      body: 'محترم {{guest_name}}، کمرہ {{room_number}}۔',
    });
    mount(view([original]));
    const preview = screen
      .getByRole('heading', { level: 2, name: 'Preview' })
      .closest<HTMLElement>('[data-slot="section-card"]')!;
    expect(within(preview).getByLabelText('{{property_name}}')).toHaveValue('Fathom Grand');
    expect(within(preview).getByLabelText('{{guest_name}}')).toHaveValue('Sara Khan');
    expect(within(preview).getByLabelText('{{room_number}}')).toHaveValue('412');
    fireEvent.change(within(preview).getByLabelText('{{guest_name}}'), {
      target: { value: 'سارہ' },
    });
    mocks.preview.mockResolvedValue({
      template: original,
      rendered: {
        subject: 'Fathom Grand میں خوش آمدید',
        body: 'محترم سارہ، کمرہ 412۔',
        placeholders: [],
      },
      propertySideCheck: {
        ok: false,
        reason: 'TEMPLATE_NOT_APPROVED',
        message: 'This template is not approved, so it cannot be sent to a guest.',
      },
    });
    await act(async () => {
      fireEvent.click(within(preview).getByRole('button', { name: 'Preview this version' }));
    });
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(
      {
        branchId: 'branch',
        id: 'original',
        context: { property_name: 'Fathom Grand', guest_name: 'سارہ', room_number: '412' },
      },
      { staleTime: 0 }
    );
    const rendered = screen.getByTestId('journey-preview');
    expect(rendered).toHaveTextContent('محترم سارہ، کمرہ 412۔');
    expect(within(rendered).getByText('محترم سارہ، کمرہ 412۔')).toHaveAttribute('dir', 'rtl');
    expect(within(rendered).getByRole('status')).toHaveTextContent('not approved');
  });

  it('lands a missing value on the sample values and clears the preview when another version opens', async () => {
    mount(view([row(), row({ id: 'second', version: 2 })]));
    mocks.preview.mockResolvedValueOnce({
      template: row(),
      rendered: {
        subject: 'Welcome to Fathom Grand',
        body: 'Hello Sara Khan, room 412.',
        placeholders: [],
      },
      propertySideCheck: { ok: true },
    });
    await act(async () => {
      click('Preview this version');
    });
    expect(screen.getByTestId('journey-preview')).toHaveTextContent('could be sent right now');
    mocks.preview.mockRejectedValueOnce(
      refused('BAD_REQUEST', { context: ['This message needs a value for {{room_number}}.'] })
    );
    await act(async () => {
      click('Preview this version');
    });
    expect(screen.queryByTestId('journey-preview')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('needs a value for {{room_number}}');
    expect(screen.getByRole('group', { name: 'Sample values' })).toHaveAccessibleDescription(
      'This message needs a value for {{room_number}}.'
    );
    mocks.preview.mockResolvedValueOnce({
      template: row(),
      rendered: {
        subject: 'Welcome to Fathom Grand',
        body: 'Hello Sara Khan, room 412.',
        placeholders: [],
      },
      propertySideCheck: { ok: true },
    });
    await act(async () => {
      click('Preview this version');
    });
    expect(screen.getByTestId('journey-preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /version 2/ }));
    expect(screen.queryByTestId('journey-preview')).not.toBeInTheDocument();
  });

  it('offers no preview for a new draft that is not stored yet', () => {
    mount(view([]));
    expect(screen.queryByRole('heading', { level: 2, name: 'Preview' })).not.toBeInTheDocument();
  });
});
