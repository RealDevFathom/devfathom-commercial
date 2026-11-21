import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HotelMealPlansPanel, describeMeal, type HotelMealPlansView } from './meal-plans-panel';

type Callbacks = {
  onSuccess?: (result: unknown, input: unknown) => void;
  onError?: (error: { message: string; data: { code: string; validation?: unknown } }) => void;
};
const h = vi.hoisted(() => ({
  mutate: {} as Record<string, ReturnType<typeof vi.fn>>,
  hookCallbacks: {} as Record<string, Callbacks>,
  fetchList: vi.fn(),
  session: { user: { id: 'user', organizationId: 'org' } },
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: h.session }) }));
vi.mock('@/lib/trpc', () => {
  const mutation = (name: string) => ({
    useMutation: (options?: Callbacks) => {
      h.hookCallbacks[name] = options ?? {};
      h.mutate[name] ??= vi.fn();
      return { mutate: h.mutate[name], isPending: false };
    },
  });
  return {
    trpc: {
      useUtils: () => ({ hotelRates: { mealPlans: { list: { fetch: h.fetchList } } } }),
      hotelRates: {
        mealPlans: {
          create: mutation('create'),
          update: mutation('update'),
          setActive: mutation('setActive'),
        },
      },
    },
  };
});

const selection = { userId: 'user', organizationId: 'org', branchId: 'branch' };
const version = new Date('2026-10-01T08:30:00.000Z');
const ep = {
  id: 'plan_ep',
  code: 'EP',
  name: 'Room only',
  nameUr: 'صرف کمرہ',
  meals: [],
  active: true,
  updatedAt: version,
  standard: true,
};
const cp = {
  id: 'plan_cp',
  code: 'CP',
  name: 'Bed & breakfast',
  nameUr: 'کمرہ اور ناشتہ',
  meals: [{ meal: 'BREAKFAST', outlets: [], cutoff_time: '10:30', per_person: true }],
  active: true,
  updatedAt: version,
  standard: true,
};
const map = {
  id: 'plan_map',
  code: 'MAP',
  name: 'Half board',
  nameUr: null,
  meals: [
    { meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true },
    { meal: 'DINNER', outlets: ['Terrace', 'Grill'], cutoff_time: null, per_person: false },
  ],
  active: false,
  updatedAt: version,
  standard: true,
};
function view(plans = [ep, cp, map]): HotelMealPlansView {
  return {
    plans,
    mealOptions: [
      { value: 'BREAKFAST', label: 'Breakfast' },
      { value: 'LUNCH', label: 'Lunch' },
      { value: 'DINNER', label: 'Dinner' },
    ],
    standardCodes: ['EP', 'CP', 'MAP', 'AP'],
  } as unknown as HotelMealPlansView;
}
const error = (code: string, validation?: Record<string, string[]>) => ({
  message: 'Refused',
  data: { code, validation },
});
const lastCallbacks = (name: string) => h.mutate[name].mock.lastCall?.[1] as Callbacks;

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(h.mutate)) fn.mockReset();
  h.session = { user: { id: 'user', organizationId: 'org' } };
  h.fetchList.mockResolvedValue(view());
});
afterEach(cleanup);
const mount = (initial = view()) =>
  render(<HotelMealPlansPanel initial={initial} selection={selection} />);
const addForm = () => screen.getByRole('form', { name: 'Add a meal plan' });
const plansCard = () =>
  screen
    .getByRole('heading', { level: 2, name: /^Meal plans \(/ })
    .closest<HTMLElement>('[data-slot="section-card"]')!;
const rowOf = (code: string) =>
  within(plansCard())
    .getAllByRole('row')
    .find((row) => within(row).queryAllByRole('cell')[0]?.textContent?.startsWith(code))!;

describe('HotelMealPlansPanel', () => {
  it('names services, bases and sale state for an operator and never prints a stored key', () => {
    mount();
    const card = plansCard();
    expect(within(card).getByText('2 of 3 on sale.', { exact: false })).toBeInTheDocument();
    expect(within(card).getByText('Room only — no meals')).toBeInTheDocument();
    expect(within(card).getByText('Breakfast — per person · by 10:30')).toBeInTheDocument();
    expect(within(card).getByText('Dinner — per room · 2 outlets')).toBeInTheDocument();
    expect(within(card).getByText('صرف کمرہ')).toBeInTheDocument();
    expect(within(card).getAllByText('Industry code')).toHaveLength(3);
    expect(within(card).getAllByText('On sale')).toHaveLength(2);
    expect(within(card).getByText('Not sold')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/per_person|cutoff_time|plan_cp|BREAKFAST/);
    expect(
      describeMeal({ meal: 'LUNCH', outlets: ['One'], cutoff_time: null, per_person: true })
    ).toBe('Lunch — per person · 1 outlet');
  });

  it('adds a plan from named services with the selection attached and the document in the stored shape', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'HB-TERRACE' } });
    fireEvent.change(within(addForm()).getByLabelText('Name'), {
      target: { value: 'Half board on the terrace' },
    });
    fireEvent.change(within(addForm()).getByLabelText('Name in Urdu'), {
      target: { value: 'چھت پر' },
    });
    // Breakfast per person with a cut-off; dinner per room at two outlets; no lunch.
    fireEvent.click(within(addForm()).getByLabelText('Breakfast'));
    fireEvent.change(screen.getByLabelText('Cut-off', { selector: '#new-cutoff-BREAKFAST' }), {
      target: { value: '10:30' },
    });
    fireEvent.click(within(addForm()).getByLabelText('Dinner'));
    fireEvent.change(screen.getByLabelText('Basis', { selector: '#new-basis-DINNER' }), {
      target: { value: 'per_room' },
    });
    fireEvent.change(screen.getByLabelText('Outlets', { selector: '#new-outlets-DINNER' }), {
      target: { value: 'Terrace, Rooftop grill' },
    });
    fireEvent.click(within(addForm()).getByLabelText('Put on sale now'));
    fireEvent.submit(addForm());
    expect(h.mutate.create).toHaveBeenCalledWith({
      branchId: 'branch',
      code: 'HB-TERRACE',
      name: 'Half board on the terrace',
      nameUr: 'چھت پر',
      active: false,
      meals: [
        { meal: 'BREAKFAST', per_person: true, cutoff_time: '10:30', outlets: [] },
        {
          meal: 'DINNER',
          per_person: false,
          cutoff_time: null,
          outlets: ['Terrace', 'Rooftop grill'],
        },
      ],
    });
  });

  it('sends an empty document for a room-only plan and defaults to on sale', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'RO' } });
    fireEvent.change(within(addForm()).getByLabelText('Name'), { target: { value: 'Room only' } });
    fireEvent.submit(addForm());
    expect(h.mutate.create).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RO', meals: [], active: true, nameUr: null })
    );
  });

  it('lands server field errors under their inputs and keeps the entries, then announces a save', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'CP' } });
    fireEvent.change(within(addForm()).getByLabelText('Name'), { target: { value: 'Again' } });
    fireEvent.submit(addForm());
    act(() => {
      h.hookCallbacks.create!.onError!(
        error('BAD_REQUEST', { code: ['This property already sells a plan coded CP.'] })
      );
    });
    const code = screen.getByLabelText('Code');
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(code).toHaveValue('CP');
    expect(screen.getByRole('alert')).toHaveTextContent('already sells a plan coded CP');
    act(() => {
      h.hookCallbacks.create!.onError!(
        error('BAD_REQUEST', { meals: ['This plan already covers breakfast.'] })
      );
    });
    expect(screen.getByRole('group', { name: 'What the plan covers' })).toHaveAccessibleDescription(
      'This plan already covers breakfast.'
    );
    await act(async () => {
      h.hookCallbacks.create!.onSuccess!(
        { plan: { ...cp, code: 'HB', name: 'Half board', active: false } },
        undefined
      );
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'HB · Half board is set up and not yet on sale.'
    );
    // The form was replaced and the list re-fetched past the cache.
    expect(screen.getByLabelText('Code')).toHaveValue('');
    expect(h.fetchList).toHaveBeenCalledWith({ branchId: 'branch' }, { staleTime: 0 });
  });

  it('edits a plan inline with its version, keeps the code fixed, and hands focus back on close', async () => {
    mount();
    const edit = within(rowOf('MAP')).getByRole('button', { name: 'Edit MAP' });
    fireEvent.click(edit);
    expect(edit).toHaveAttribute('aria-expanded', 'true');
    const editor = screen.getByRole('form', { name: 'Edit MAP' });
    expect(within(editor).getByLabelText('Name')).toHaveFocus();
    expect(within(editor).queryByLabelText('Code')).not.toBeInTheDocument();
    expect(within(editor).getByText(/Fixed: it is the plan’s identity/)).toBeInTheDocument();
    // Stored values are offered back: dinner is per room at two outlets.
    expect(screen.getByLabelText('Basis', { selector: '#plan-plan_map-basis-DINNER' })).toHaveValue(
      'per_room'
    );
    expect(
      screen.getByLabelText('Outlets', { selector: '#plan-plan_map-outlets-DINNER' })
    ).toHaveValue('Terrace, Grill');
    // The add form is held while an editor is open.
    expect(within(addForm()).getByRole('button', { name: 'Add meal plan' })).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText('Name'), {
      target: { value: 'Half board plus' },
    });
    fireEvent.click(within(editor).getByLabelText('Lunch'));
    fireEvent.submit(editor);
    expect(h.mutate.update).toHaveBeenCalledWith(
      {
        branchId: 'branch',
        id: 'plan_map',
        expectedUpdatedAt: version,
        active: false,
        name: 'Half board plus',
        nameUr: null,
        meals: [
          { meal: 'BREAKFAST', per_person: true, cutoff_time: null, outlets: [] },
          { meal: 'LUNCH', per_person: true, cutoff_time: null, outlets: [] },
          { meal: 'DINNER', per_person: false, cutoff_time: null, outlets: ['Terrace', 'Grill'] },
        ],
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) })
    );
    await act(async () => {
      lastCallbacks('update').onSuccess!({ plan: map }, undefined);
    });
    expect(screen.queryByRole('form', { name: 'Edit MAP' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(within(rowOf('MAP')).getByRole('button', { name: 'Edit MAP' })).toHaveFocus();
  });

  it('closes the editor with Escape and reports a conflict without losing the entries', () => {
    mount();
    fireEvent.click(within(rowOf('CP')).getByRole('button', { name: 'Edit CP' }));
    const editor = screen.getByRole('form', { name: 'Edit CP' });
    fireEvent.change(within(editor).getByLabelText('Name'), { target: { value: 'B&B deluxe' } });
    fireEvent.submit(editor);
    act(() => {
      lastCallbacks('update').onError!(error('CONFLICT'));
    });
    expect(within(editor).getByRole('alert')).toHaveTextContent('Your entries are kept');
    expect(within(editor).getByLabelText('Name')).toHaveValue('B&B deluxe');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'Edit CP' })).not.toBeInTheDocument();
    expect(within(rowOf('CP')).getByRole('button', { name: 'Edit CP' })).toHaveFocus();
  });

  it('withdraws a plan from sale and puts one back, carrying the version it saw', async () => {
    mount();
    fireEvent.click(within(rowOf('CP')).getByRole('button', { name: 'Withdraw CP' }));
    expect(h.mutate.setActive).toHaveBeenCalledWith(
      { branchId: 'branch', id: 'plan_cp', active: false, expectedUpdatedAt: version },
      expect.anything()
    );
    await act(async () => {
      lastCallbacks('setActive').onSuccess!({ id: 'plan_cp', active: false }, undefined);
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'CP is withdrawn from sale. Confirmed stays keep their plan.'
    );
    fireEvent.click(within(rowOf('MAP')).getByRole('button', { name: 'Put on sale MAP' }));
    expect(h.mutate.setActive).toHaveBeenLastCalledWith(
      { branchId: 'branch', id: 'plan_map', active: true, expectedUpdatedAt: version },
      expect.anything()
    );
    act(() => {
      lastCallbacks('setActive').onError!(error('CONFLICT'));
    });
    expect(within(rowOf('MAP')).getByRole('alert')).toHaveTextContent('changed elsewhere');
  });

  it('refresh bypasses a cached list and rechecks revoked access', async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh plans' }));
    });
    expect(h.fetchList).toHaveBeenCalledWith({ branchId: 'branch' }, { staleTime: 0 });
    h.fetchList.mockRejectedValueOnce(error('FORBIDDEN'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh plans' }));
    });
    expect(screen.getByRole('heading', { name: 'Choose a property again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a property' })).toHaveAttribute(
      'href',
      '/hotel/settings/meal-plans'
    );
  });

  it('keeps the last list and offers a retry when a refresh fails for another reason', async () => {
    mount();
    h.fetchList.mockRejectedValueOnce(error('INTERNAL_SERVER_ERROR'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh plans' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh the meal plans');
    expect(screen.getByRole('button', { name: 'Retry refresh' })).toBeInTheDocument();
    expect(within(plansCard()).getByText('Bed & breakfast')).toBeInTheDocument();
  });

  it('reloads on an identity change instead of writing under the old selection', () => {
    h.session = { user: { id: 'someone-else', organizationId: 'org' } };
    mount();
    expect(screen.getByRole('heading', { name: 'Reload the meal plans' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add a meal plan' })).not.toBeInTheDocument();
  });

  it('takes no focus when it mounts, and none when a row re-renders with its editor closed', async () => {
    mount();
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh plans' }));
    });
    expect(screen.queryByRole('button', { name: 'Edit CP' })).not.toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Edit EP' })).not.toHaveFocus();
  });

  it('explains an empty list with the next action', () => {
    mount(view([]));
    expect(screen.getByText(/No meal plans yet/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Meal plans (0)' })).toBeInTheDocument();
    expect(addForm()).toBeInTheDocument();
  });
});
