import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueryValue = { data?: unknown; error?: unknown; loading?: boolean };

const h = vi.hoisted(() => ({
  modules: ['pharmacy-core', 'pharmacy-safety'] as string[],
  queries: {} as Record<string, QueryValue | ((input: unknown) => QueryValue)>,
  outcomes: {} as Record<string, (input: unknown) => unknown>,
  calls: {} as Record<string, unknown[]>,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({
    organizationId: 'org',
    vertical: 'PHARMACY',
    enabledModules: h.modules,
  }),
}));
vi.mock('@/lib/trpc', () => {
  const procedure = (name: string) => ({
    useQuery: (input: unknown, options?: { enabled?: boolean }) => {
      if (options?.enabled === false) {
        return { data: undefined, error: null, isLoading: false, refetch: vi.fn() };
      }
      const entry = h.queries[name];
      const value = typeof entry === 'function' ? entry(input) : (entry ?? {});
      return {
        data: value.data,
        error: value.error ?? null,
        isLoading: Boolean(value.loading),
        refetch: vi.fn(async () => ({ data: value.data })),
      };
    },
    useMutation: (options?: {
      onSuccess?: (result: unknown) => unknown;
      onError?: (error: unknown) => unknown;
    }) => ({
      isPending: false,
      isSuccess: false,
      variables: undefined,
      mutate: (
        input: unknown,
        call?: { onSuccess?: (result: unknown) => unknown; onError?: (error: unknown) => unknown }
      ) => {
        (h.calls[name] ??= []).push(input);
        const result = h.outcomes[name]?.(input) ?? {};
        if (result instanceof Error) {
          options?.onError?.(result);
          call?.onError?.(result);
        } else {
          options?.onSuccess?.(result);
          call?.onSuccess?.(result);
        }
      },
    }),
  });
  const invalidate = { invalidate: vi.fn(async () => undefined) };
  return {
    trpc: {
      pharmacySop: new Proxy({}, { get: (_target, name: string) => procedure(name) }),
      useUtils: () => ({
        pharmacySop: new Proxy({}, { get: () => invalidate }),
      }),
    },
  };
});

import { PHARMACY_SOP_NO_STAFF_PROFILE_MESSAGE } from '@/lib/pharmacy/sop-shared';

import { PharmacySopWorkspace } from './pharmacy-sop-workspace';
import { initialSiteTimezone, SETUP_INTRO } from './sop-setup';

const BRANCH = 'branch-1';
const due = new Date('2026-11-04T04:00:00Z');

function boardItem(overrides: Record<string, unknown>) {
  return {
    occurrenceId: 'occ',
    status: 'SCHEDULED',
    businessDate: new Date('2026-11-04T00:00:00Z'),
    dueAt: due,
    windowEndsAt: new Date('2026-11-04T08:00:00Z'),
    startedAt: null,
    submittedAt: null,
    templateId: 'tpl',
    templateName: 'Pharmacy — opening',
    category: 'Opening',
    packKey: 'opening',
    roleKey: 'pharmacy-assistant',
    poolRoleKey: null,
    claimed: false,
    stepsTotal: 2,
    stepsCompleted: 0,
    overdue: false,
    missedRisk: false,
    ...overrides,
  };
}

function step(overrides: Record<string, unknown>) {
  return {
    id: 'step-1',
    templateStepId: 'tstep-1',
    stepOrder: 1,
    title: 'Record fridge temperature',
    instructions: null,
    requiresPhoto: false,
    requiresNote: false,
    requiresSignature: false,
    requiredRecordType: null,
    completed: false,
    completedAt: null,
    completedByName: null,
    note: null,
    ...overrides,
  };
}

function occurrence(overrides: Record<string, unknown> = {}) {
  return {
    id: 'occ-mine',
    status: 'IN_PROGRESS',
    businessDate: new Date('2026-11-04T00:00:00Z'),
    dueAt: due,
    windowEndsAt: new Date('2026-11-04T08:00:00Z'),
    startedAt: due,
    submittedAt: null,
    resolvedAt: null,
    overdue: false,
    template: { id: 'tpl', name: 'Pharmacy — opening', category: 'Opening' },
    pack: null,
    poolRoleKey: null,
    viewer: { isOwner: true, canClaim: false, canVerify: false },
    steps: [step({ requiresNote: true })],
    evidence: [],
    recordLinks: [],
    verifications: [],
    auditTrail: [],
    ...overrides,
  };
}

function setup({
  access = { canComplete: true, canVerify: false, canManage: false },
  sopBranchId = 'sop-1' as string | null,
  board = {} as Record<string, unknown>,
  occ = occurrence() as Record<string, unknown>,
} = {}) {
  h.queries = {
    access: { data: access },
    branches: {
      data: [
        { pharmacyBranchId: BRANCH, name: 'Main Street', sopBranchId, timezone: 'Asia/Karachi' },
      ],
    },
    board: {
      data: {
        businessDate: '2026-11-04',
        canReview: false,
        mine: [boardItem({ occurrenceId: 'occ-mine', status: 'IN_PROGRESS' })],
        pool: [
          boardItem({
            occurrenceId: 'occ-pool',
            templateName: 'Pharmacy — hygiene',
            poolRoleKey: 'pharmacy-assistant',
            overdue: true,
          }),
        ],
        review: [],
        counts: { overdue: 1, dueToday: 2, awaitingReview: 0 },
        ...board,
      },
    },
    occurrence: { data: occ },
    templates: { data: [] },
    onDemandTemplates: { data: [] },
    linkableRecords: { data: [] },
  };
}

beforeEach(() => {
  window.history.replaceState(null, '', '/pharmacy/sop');
  h.modules = ['pharmacy-core', 'pharmacy-safety'];
  h.outcomes = {};
  h.calls = {};
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
});

describe('pharmacy procedures workspace', () => {
  it('shows a forbidden state when the person holds no procedure capability', () => {
    setup({ access: { canComplete: false, canVerify: false, canManage: false } });
    render(<PharmacySopWorkspace />);
    expect(
      screen.getByRole('heading', { name: 'Procedures are not available to you' })
    ).toBeVisible();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('shows the forbidden state without the Pharmacy Safety module, before asking the server', () => {
    setup();
    h.modules = ['pharmacy-core'];
    render(<PharmacySopWorkspace />);
    expect(
      screen.getByRole('heading', { name: 'Procedures are not available to you' })
    ).toBeVisible();
  });

  it('shows a forbidden state when the server refuses access', () => {
    setup();
    h.queries.access = { error: { message: 'FORBIDDEN', data: { code: 'FORBIDDEN' } } };
    render(<PharmacySopWorkspace />);
    expect(
      screen.getByRole('heading', { name: 'Procedures are not available to you' })
    ).toBeVisible();
  });

  it('offers recovery when the workspace fails to load for another reason', () => {
    setup();
    h.queries.branches = {
      error: { message: 'Network unavailable', data: { code: 'INTERNAL_SERVER_ERROR' } },
    };
    render(<PharmacySopWorkspace />);
    expect(screen.getByRole('heading', { name: 'Procedures could not be loaded' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  it('explains a branch that is not set up, and sends managers to setup', () => {
    setup({ sopBranchId: null });
    const { unmount } = render(<PharmacySopWorkspace />);
    expect(
      screen.getByRole('heading', { name: 'Procedures are not set up at this branch yet' })
    ).toBeVisible();
    expect(screen.getByText(/Ask your pharmacy manager/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Set up this branch' })).not.toBeInTheDocument();
    unmount();

    setup({ sopBranchId: null, access: { canComplete: true, canVerify: false, canManage: true } });
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up this branch' }));
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Turn on procedures' })).toBeVisible();
    expect(screen.getByText(/It does not schedule anything/)).toBeVisible();
  });

  it('renders my work and the role pool, and claims from the pool', () => {
    setup();
    render(<PharmacySopWorkspace />);
    const mine = screen.getByRole('list', { name: 'My work' });
    expect(within(mine).getByText('Pharmacy — opening')).toBeVisible();
    const pool = screen.getByRole('list', { name: 'Role pool' });
    expect(within(pool).getByText('Pharmacy — hygiene')).toBeVisible();
    expect(within(pool).getByText('Overdue')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Claim Pharmacy — hygiene' }));
    expect(h.calls.claim).toEqual([{ pharmacyBranchId: BRANCH, occurrenceId: 'occ-pool' }]);
    expect(screen.getByText('Claimed. It is now in your work.')).toBeVisible();
  });

  it('uses the Studio timezone picker to turn on procedures for the selected zone', async () => {
    setup({ sopBranchId: null, access: { canComplete: true, canVerify: false, canManage: true } });
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up this branch' }));

    const timezone = screen.getByRole('combobox', { name: /^Branch timezone/ });
    expect(timezone).toHaveAttribute('data-select-field-trigger');
    expect(timezone).toHaveAccessibleDescription('Due times and reports use this timezone.');
    expect(timezone).toHaveTextContent('Asia/Karachi');
    timezone.focus();
    fireEvent.keyDown(timezone, { key: 'ArrowDown' });
    const london = await screen.findByRole('option', { name: 'Europe/London' });
    london.focus();
    fireEvent.keyDown(london, { key: 'Enter' });
    // jsdom does not synthesize the click a browser sends for Enter.
    fireEvent.click(london, { detail: 0 });
    await waitFor(() => expect(timezone).toHaveTextContent('Europe/London'));

    fireEvent.click(screen.getByRole('button', { name: 'Turn on procedures' }));
    expect(h.calls.enableSite).toEqual([{ pharmacyBranchId: BRANCH, timezone: 'Europe/London' }]);
  });

  it('shows a claim conflict in plain words', () => {
    setup();
    h.outcomes.claim = () =>
      Object.assign(new Error('Someone else has already claimed this procedure.'), {
        data: { code: 'CONFLICT' },
      });
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Claim Pharmacy — hygiene' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Someone else has already claimed this procedure.'
    );
  });

  it('completes a step only once its note is written', () => {
    setup();
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Pharmacy — opening' }));
    const done = screen.getByRole('button', { name: 'Mark step 1 done' });
    expect(done).toBeDisabled();
    expect(screen.getByRole('list', { name: 'Still needed for step 1' })).toHaveTextContent(
      'Write a note.'
    );

    fireEvent.change(screen.getByLabelText(/Note · required/), {
      target: { value: 'Fridge at 5 °C' },
    });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(h.calls.completeStep).toEqual([
      {
        pharmacyBranchId: BRANCH,
        occurrenceId: 'occ-mine',
        templateStepId: 'tstep-1',
        note: 'Fridge at 5 °C',
      },
    ]);
  });

  it('lists every reason submission is blocked', () => {
    setup({
      occ: occurrence({
        steps: [
          step({ requiredRecordType: 'TEMPERATURE_LOG' }),
          step({
            id: 'step-2',
            templateStepId: 'tstep-2',
            stepOrder: 2,
            title: 'Sign in as the person in charge',
            requiresSignature: true,
          }),
        ],
      }),
    });
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Pharmacy — opening' }));

    const blocked = screen.getByRole('list', { name: 'What is still needed' });
    expect(blocked).toHaveTextContent('Step 1, “Record fridge temperature”, is not done yet.');
    expect(blocked).toHaveTextContent(
      'Step 2, “Sign in as the person in charge”, is not done yet.'
    );
    expect(screen.getByRole('button', { name: 'Send for review' })).toBeDisabled();
    expect(screen.getByRole('list', { name: 'Still needed for step 1' })).toHaveTextContent(
      'Link the temperature log this step checked.'
    );
    expect(screen.getByRole('list', { name: 'Still needed for step 2' })).toHaveTextContent(
      'Add your signature.'
    );
  });

  it('sends for review once every step is done, and shows a refused submit as given', () => {
    setup({
      occ: occurrence({ steps: [step({ completed: true, completedAt: due })] }),
    });
    h.outcomes.submit = () =>
      Object.assign(
        new Error(
          'A linked temperature reading is out of range. Add a note describing the excursion and corrective action before submitting.'
        ),
        { data: { code: 'PRECONDITION_FAILED' } }
      );
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Pharmacy — opening' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    expect(h.calls.submit).toEqual([{ pharmacyBranchId: BRANCH, occurrenceId: 'occ-mine' }]);
    expect(screen.getByRole('alert')).toHaveTextContent(/out of range/);
  });

  it('keeps an unsaved note through back navigation, by button and by the browser', async () => {
    setup();
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Pharmacy — opening' }));
    expect(window.location.search).toContain('occurrence=occ-mine');
    fireEvent.change(screen.getByLabelText(/Note · required/), { target: { value: 'Half done' } });

    fireEvent.click(screen.getByRole('button', { name: "Back to today's work" }));
    // In-app Back steps back through history (no new entry), so the URL
    // follows once the browser has moved.
    await waitFor(() => expect(window.location.search).not.toContain('occurrence'));
    expect(screen.getByRole('list', { name: 'My work' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open Pharmacy — opening' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Open Pharmacy — opening' }));
    expect(screen.getByLabelText(/Note · required/)).toHaveValue('Half done');

    // The browser Back button: the URL changes, then popstate fires.
    await act(async () => {
      window.history.replaceState(null, '', '/pharmacy/sop?branch=branch-1&view=board');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByRole('list', { name: 'My work' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open Pharmacy — opening' }));
    expect(screen.getByLabelText(/Note · required/)).toHaveValue('Half done');
  });

  it('hides review from people who do not review at this branch', () => {
    setup({ access: { canComplete: true, canVerify: false, canManage: false } });
    const { unmount } = render(<PharmacySopWorkspace />);
    expect(screen.queryByRole('tab', { name: 'Review' })).not.toBeInTheDocument();
    unmount();

    // The capability alone is not enough: the board must say they hold a reviewer role here.
    setup({
      access: { canComplete: true, canVerify: true, canManage: false },
      board: { canReview: false },
    });
    const second = render(<PharmacySopWorkspace />);
    expect(screen.queryByRole('tab', { name: 'Review' })).not.toBeInTheDocument();
    second.unmount();

    setup({
      access: { canComplete: true, canVerify: true, canManage: false },
      board: { canReview: true },
    });
    render(<PharmacySopWorkspace />);
    expect(screen.getByRole('tab', { name: 'Review' })).toBeVisible();
  });

  it('shows reports only to managers and reviewers, not to staff who only complete', () => {
    setup({ access: { canComplete: true, canVerify: false, canManage: false } });
    const first = render(<PharmacySopWorkspace />);
    expect(screen.getByRole('tab', { name: "Today's work" })).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Reports' })).not.toBeInTheDocument();
    first.unmount();

    setup({ access: { canComplete: false, canVerify: true, canManage: false } });
    const second = render(<PharmacySopWorkspace />);
    expect(screen.getByRole('tab', { name: 'Reports' })).toBeVisible();
    second.unmount();

    setup({ access: { canComplete: false, canVerify: false, canManage: true } });
    render(<PharmacySopWorkspace />);
    expect(screen.getByRole('tab', { name: 'Reports' })).toBeVisible();
  });

  it('requires a reason before sending a procedure back', () => {
    setup({
      access: { canComplete: true, canVerify: true, canManage: false },
      board: {
        canReview: true,
        review: [boardItem({ occurrenceId: 'occ-review', status: 'SUBMITTED', submittedAt: due })],
      },
      occ: occurrence({
        id: 'occ-review',
        status: 'SUBMITTED',
        viewer: { isOwner: false, canClaim: false, canVerify: true },
        steps: [step({ completed: true, completedAt: due })],
      }),
    });
    window.history.replaceState(null, '', '/pharmacy/sop?view=review');
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Review Pharmacy — opening' }));
    expect(screen.getByRole('button', { name: 'Back to review' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send for review' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(h.calls.reject).toBeUndefined();
    const reason = screen.getByLabelText('Reason');
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    expect(reason).toHaveFocus();
    expect(screen.getByText('Write what needs fixing before sending it back.')).toBeVisible();

    fireEvent.change(reason, { target: { value: 'Photo of the fridge display is missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    expect(h.calls.reject).toEqual([
      {
        pharmacyBranchId: BRANCH,
        occurrenceId: 'occ-review',
        reason: 'Photo of the fridge display is missing',
      },
    ]);
  });

  it('opens a deep-linked review in the Review panel only, even while the board loads', () => {
    setup({
      access: { canComplete: true, canVerify: true, canManage: false },
      board: {
        canReview: true,
        review: [boardItem({ occurrenceId: 'occ-review', status: 'SUBMITTED', submittedAt: due })],
      },
      occ: occurrence({
        id: 'occ-review',
        status: 'SUBMITTED',
        viewer: { isOwner: false, canClaim: false, canVerify: true },
        steps: [step({ completed: true, completedAt: due })],
      }),
    });
    const loaded = h.queries.board;
    // As in a browser, the tabs keep the closing panel mounted until its exit
    // animations finish (jsdom has none, so it would otherwise unmount at once).
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value: () => [],
    });
    window.history.replaceState(null, '', '/pharmacy/sop?view=review&occurrence=occ-review');
    // Until the board says this person reviews here, only Today's work exists.
    h.queries.board = { loading: true };
    const { rerender } = render(<PharmacySopWorkspace />);
    const runners = () =>
      screen.queryAllByRole('group', { name: 'Pharmacy — opening', hidden: true });
    expect(runners()).toHaveLength(1);

    h.queries.board = loaded;
    rerender(<PharmacySopWorkspace />);
    // The closing panel never holds a second copy of the procedure.
    expect(screen.getAllByRole('tabpanel', { hidden: true }).length).toBeGreaterThan(1);
    expect(runners()).toHaveLength(1);
    const panel = screen.getAllByRole('tabpanel').find((node) => !node.hasAttribute('inert'));
    expect(within(panel!).getByRole('button', { name: 'Back to review' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: /^Back to /, hidden: true })).toHaveLength(1);
  });

  // ── Visual QA follow-ups ──────────────────────────────────────────────────

  it('gives every tab trigger a 44px touch target', () => {
    setup({ access: { canComplete: true, canVerify: false, canManage: true } });
    render(<PharmacySopWorkspace />);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toMatch(/(^|\s)h-11(\s|$)/);
      expect(tab.className).not.toContain('h-[calc(100%-1px)]');
    }
  });

  it('offers to set up a procedures profile when the board has none for this person', () => {
    setup();
    h.queries.board = {
      error: {
        message: PHARMACY_SOP_NO_STAFF_PROFILE_MESSAGE,
        data: { code: 'PRECONDITION_FAILED' },
      },
    };
    render(<PharmacySopWorkspace />);
    expect(screen.getByRole('heading', { name: 'Set up your procedures profile' })).toBeVisible();
    expect(screen.queryByText("Today's work could not be loaded")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set up my procedures profile' }));
    expect(h.calls.joinSite).toEqual([{ pharmacyBranchId: BRANCH }]);
  });

  it('groups tomorrow’s work under its own label', () => {
    setup({
      board: {
        mine: [
          boardItem({ occurrenceId: 'occ-today', templateName: 'Pharmacy — opening' }),
          boardItem({
            occurrenceId: 'occ-tomorrow',
            templateName: 'Pharmacy — closing',
            businessDate: new Date('2026-11-05T00:00:00Z'),
          }),
        ],
        pool: [],
      },
    });
    render(<PharmacySopWorkspace />);
    expect(
      within(screen.getByRole('list', { name: 'My work' })).getByText('Pharmacy — opening')
    ).toBeVisible();
    const tomorrow = screen.getByRole('list', { name: 'My work, tomorrow' });
    expect(within(tomorrow).getByText('Pharmacy — closing')).toBeVisible();
    expect(
      within(screen.getByRole('list', { name: 'My work' })).queryByText('Pharmacy — closing')
    ).not.toBeInTheDocument();
    expect(screen.getByText('Tomorrow')).toBeVisible();
  });

  it('does not let a manager tick their own reviewing roles, and says why', () => {
    setup({ access: { canComplete: true, canVerify: false, canManage: true } });
    h.queries.roleHoldings = {
      data: [
        {
          userId: 'me',
          isViewer: true,
          name: 'Mona',
          email: 'm@x',
          staffProfile: 'ONE',
          staffProfileId: 'sp_me',
          displayName: 'Mona',
          roleKeys: ['pharmacy-manager'],
        },
        {
          userId: 'other',
          isViewer: false,
          name: 'Paul',
          email: 'p@x',
          staffProfile: 'NONE',
          staffProfileId: null,
          displayName: 'Paul',
          roleKeys: [],
        },
      ],
    };
    h.queries.assignments = { data: [] };
    window.history.replaceState(null, '', '/pharmacy/sop?view=setup');
    render(<PharmacySopWorkspace />);
    // Setup says once that procedures never gate pharmacy work.
    expect(screen.getByText(SETUP_INTRO)).toBeVisible();
    expect(SETUP_INTRO).toContain('They never block opening, closing or any other pharmacy work.');
    const qp = screen.getByLabelText('Qualified person (pharmacist) for Mona');
    expect(qp).toBeDisabled();
    expect(qp).toHaveAccessibleDescription(/cannot give yourself the manager or qualified-person/);
    // Holding it already: removing your own reviewing role stays possible.
    expect(screen.getByLabelText('Pharmacy manager for Mona')).toBeEnabled();
    expect(screen.getByLabelText('Pharmacy assistant for Mona')).toBeEnabled();
    expect(screen.getByLabelText('Pharmacy manager for Paul')).toBeEnabled();
    expect(screen.getByLabelText('Qualified person (pharmacist) for Paul')).toBeEnabled();
  });

  describe('schedule form', () => {
    const template = {
      id: 'tpl-train',
      name: 'Pharmacy — training attestation',
      category: 'Training',
      isActive: true,
      publishedVersion: { id: 'v1', versionNumber: 1 },
      steps: [],
      pack: {
        key: 'training-attestation',
        name: 'Pharmacy — training attestation',
        category: 'Training',
        description: '',
        roleKey: 'pharmacy-assistant',
        assigneeTarget: 'ROLE',
        verifierRoleKeys: ['pharmacy-manager'],
        trigger: 'ASSIGNED',
        suggestedRecurrence: {
          frequency: 'ONCE',
          interval: 1,
          daysOfWeek: [],
          monthDay: null,
          dueTimeMinutes: null,
          intervalEndTimeMinutes: null,
          windowMinutes: 1440,
          graceMinutes: 1440,
        },
      },
    };

    function openForm() {
      setup({ access: { canComplete: true, canVerify: false, canManage: true } });
      h.queries.templates = { data: [template] };
      h.queries.roleHoldings = { data: [] };
      h.queries.assignments = { data: [] };
      window.history.replaceState(null, '', '/pharmacy/sop?view=setup');
      render(<PharmacySopWorkspace />);
      fireEvent.click(
        screen.getByRole('button', { name: 'Create schedule for Pharmacy — training attestation' })
      );
      const form = screen.getByRole('form', {
        name: 'Schedule for Pharmacy — training attestation',
      });
      // No time is prefilled; the manager always chooses one.
      fireEvent.change(within(form).getByLabelText('Due at'), { target: { value: '15:00' } });
      return form;
    }

    it('saves the suggested schedule as offered', () => {
      const form = openForm();
      fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
      expect(h.calls.createAssignment).toEqual([
        expect.objectContaining({ frequency: 'ONCE', windowMinutes: 1440, graceMinutes: 1440 }),
      ]);
    });

    it('checks window and grace bounds before sending, field by field', () => {
      const form = openForm();
      const window = within(form).getByLabelText('Time allowed (minutes)');
      const grace = within(form).getByLabelText('Extra time before it is missed (minutes)');
      fireEvent.change(window, { target: { value: '10080' } });
      fireEvent.change(grace, { target: { value: '-5' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
      expect(h.calls.createAssignment).toBeUndefined();
      expect(window).toHaveAttribute('aria-invalid', 'true');
      expect(window).toHaveAccessibleDescription(/Enter whole minutes from 0 to 1440/);
      expect(grace).toHaveAttribute('aria-invalid', 'true');
      expect(window).toHaveFocus();
      expect(within(form).getByRole('alert')).toHaveTextContent('Check the highlighted fields.');
    });

    it('maps a server validation refusal to plain field messages, never raw validation text', () => {
      h.outcomes.createAssignment = () =>
        Object.assign(new Error('Window minutes: Number must be less than or equal to 1440'), {
          data: {
            code: 'BAD_REQUEST',
            validation: { windowMinutes: ['Number must be less than or equal to 1440'] },
          },
        });
      const form = openForm();
      fireEvent.click(within(form).getByRole('button', { name: 'Create schedule' }));
      const window = within(form).getByLabelText('Time allowed (minutes)');
      expect(window).toHaveAttribute('aria-invalid', 'true');
      expect(window).toHaveAccessibleDescription(/Enter whole minutes from 0 to 1440/);
      expect(form).not.toHaveTextContent('Number must be less than');
      expect(within(form).getByRole('alert')).toHaveTextContent(
        'Some values were not accepted. Check the highlighted fields.'
      );
    });
  });

  it('starts "Turn on" from the organization timezone, else the browser’s, never a guess', () => {
    expect(initialSiteTimezone('Asia/Dubai', 'Europe/London')).toBe('Asia/Dubai');
    expect(initialSiteTimezone(null, 'Europe/London')).toBe('Europe/London');
    expect(initialSiteTimezone(null, 'Not/AZone')).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
    expect(initialSiteTimezone(null, null)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('describes the on-time score by what it counts', () => {
    setup({ access: { canComplete: false, canVerify: false, canManage: true } });
    h.queries.report = {
      data: {
        score: {
          overall: {
            score: 75,
            counts: { onTime: 1, late: 1, missed: 0, rejected: 0, waived: 0, pending: 0 },
          },
          staff: [],
        },
        summary: { total: 2, withProof: 0, attribution: [] },
      },
    };
    window.history.replaceState(null, '', '/pharmacy/sop?view=reports');
    render(<PharmacySopWorkspace />);
    expect(screen.getByText(/whether or not it has been checked yet/)).toBeVisible();
    expect(screen.queryByText(/Work checked on time counts fully/)).not.toBeInTheDocument();
  });

  it('shows history in plain words, with start, claim and submit, and links proof', () => {
    const photoRef = '/api/files/pharmacy-sop-1-abc.png';
    setup({
      occ: occurrence({
        status: 'SUBMITTED',
        claimedAt: new Date('2026-11-04T04:05:00Z'),
        startedAt: new Date('2026-11-04T04:10:00Z'),
        submittedAt: new Date('2026-11-04T04:40:00Z'),
        ownerName: 'Asma',
        claimedByName: 'Asma',
        steps: [step({ completed: true, completedAt: due, requiresPhoto: true })],
        evidence: [
          {
            id: 'ev-1',
            occurrenceStepId: 'step-1',
            mimeType: 'image/png; evidence=photo',
            sizeBytes: 10,
            storageRef: photoRef,
            capturedAt: new Date('2026-11-04T04:20:00Z'),
            uploaderName: 'Asma',
            capturedInPharmacy: true,
          },
          {
            id: 'ev-2',
            occurrenceStepId: 'step-1',
            mimeType: 'image/png; evidence=signature',
            sizeBytes: 10,
            storageRef: 'javascript:alert(1)',
            capturedAt: new Date('2026-11-04T04:25:00Z'),
            uploaderName: 'Asma',
            capturedInPharmacy: false,
          },
        ],
        auditTrail: [
          {
            id: 'ev-1',
            occurrenceId: 'occ-mine',
            action: 'EVIDENCE_CAPTURED',
            at: new Date('2026-11-04T04:20:00Z'),
            actorStaffProfileId: 'sp',
            actorName: 'Asma',
            proofRef: {
              kind: 'EVIDENCE',
              evidenceId: 'ev-1',
              contentHash: 'h',
              storageRef: photoRef,
            },
            claimRef: null,
            detail: 'Captured image/png; evidence=photo evidence',
          },
          {
            id: 'ev-2',
            occurrenceId: 'occ-mine',
            action: 'EVIDENCE_CAPTURED',
            at: new Date('2026-11-04T04:25:00Z'),
            actorStaffProfileId: 'sp',
            actorName: 'Asma',
            proofRef: {
              kind: 'EVIDENCE',
              evidenceId: 'ev-2',
              contentHash: 'h',
              storageRef: 'javascript:alert(1)',
            },
            claimRef: null,
            detail: 'Captured image/png; evidence=signature evidence',
          },
          {
            id: 'step-1',
            occurrenceId: 'occ-mine',
            action: 'STEP_COMPLETED',
            at: new Date('2026-11-04T04:30:00Z'),
            actorStaffProfileId: 'sp',
            actorName: 'Asma',
            proofRef: null,
            claimRef: null,
            detail: 'Completed step: Record fridge temperature',
          },
        ],
      }),
    });
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Pharmacy — opening' }));
    const history = screen.getByRole('region', { name: 'History' });
    expect(history).not.toHaveTextContent('Captured');
    expect(history).not.toHaveTextContent('evidence=');
    const labels = within(history)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('span')?.textContent);
    expect(labels).toEqual([
      'Sent for review',
      'Step done',
      'Signature added',
      'Photo added',
      'Started',
      'Claimed from the role pool',
    ]);
    expect(history).toHaveTextContent('Step 1 · Record fridge temperature');
    const link = within(history).getByRole('link', {
      name: 'View photo for Step 1 · Record fridge temperature',
    });
    expect(link).toHaveAttribute('href', photoRef);
    expect(within(link).getByRole('img')).toHaveAttribute('src', photoRef);
    // A ref that is not a same-origin file path is never turned into a link.
    expect(history.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('states a linked-record requirement once in a step being worked on', () => {
    setup({
      occ: occurrence({
        steps: [step({ title: 'Match the delivery', requiredRecordType: 'GOODS_RECEIPT' })],
      }),
    });
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Pharmacy — opening' }));
    expect(screen.queryByText(/Needs a linked goods receipt/)).not.toBeInTheDocument();
    expect(screen.queryByText(/· required/, { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Link the goods receipt this step checked/)).toHaveLength(1);
  });
});
