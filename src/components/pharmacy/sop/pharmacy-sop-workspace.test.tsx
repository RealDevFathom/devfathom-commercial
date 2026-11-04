import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

import { PharmacySopWorkspace } from './pharmacy-sop-workspace';

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
afterEach(cleanup);

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

  it('shows a claim conflict in plain words', () => {
    setup();
    h.outcomes.claim = () =>
      Object.assign(new Error('Someone else has already claimed this occurrence.'), {
        data: { code: 'CONFLICT' },
      });
    render(<PharmacySopWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: 'Claim Pharmacy — hygiene' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Someone else has already claimed this occurrence.'
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
    expect(window.location.search).not.toContain('occurrence');
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
});
