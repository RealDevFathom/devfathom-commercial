import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  can: vi.fn(),
  createCaller: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string }) => ({ id: user.id }),
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/server/routers/restaurant-sop-execution', () => ({
  restaurantSopExecutionRouter: { createCaller: mocks.createCaller },
}));

import SopPage from './page';

const actor = {
  session: { expires: '2099-01-01', user: { id: 'user-1', organizationId: 'org-1' } },
  organization: { id: 'org-1', slug: 'acme', status: 'ACTIVE' },
  support: null,
};

const searchParams = Promise.resolve({});

function contextStub() {
  return {
    session: actor.session,
    organization: actor.organization,
    entitlements: { enabledModules: ['restaurant-sop'] },
    db: {
      restaurantBranch: { findMany: vi.fn().mockResolvedValue([]) },
      restaurantStaffProfile: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.createCaller.mockReturnValue({});
});

describe('SopPage tenancy resolution', () => {
  it('renders with a resolvable tenant actor and does not throw', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    render(await SopPage({ searchParams }));

    expect(screen.getByRole('heading', { name: 'Branch SOP board' })).toBeDefined();
    expect(screen.queryByText('Permission denied')).toBeNull();
  });

  it('never asks the context factory to re-resolve tenancy', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(contextStub());

    await SopPage({ searchParams });

    // A bare `createTRPCContext()` always throws `Workspace not found.`: the
    // `{ session: undefined }` it forwards suppresses the `auth()` call.
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({
      session: actor.session,
      organization: actor.organization,
      support: actor.support,
    });
  });

  it('renders the board access state instead of throwing when the organization is absent', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    render(await SopPage({ searchParams }));

    expect(screen.getByText('Permission denied')).toBeDefined();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });
});

describe('SopPage load failure', () => {
  it('renders a safe recovery state without exposing the server failure', async () => {
    mocks.resolveTenantActor.mockResolvedValue(actor);
    const ctx = contextStub();
    ctx.db.restaurantBranch.findMany.mockRejectedValue(
      new Error('503 database host: private.internal')
    );
    mocks.createTRPCContext.mockResolvedValue(ctx);

    render(await SopPage({ searchParams }));

    expect(screen.getByText('SOP board could not load')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry SOP board' })).toBeInTheDocument();
    expect(screen.queryByText(/private\.internal/)).not.toBeInTheDocument();
  });
});

describe('waiver credential form', () => {
  async function readyBoard() {
    const ctx = contextStub();
    ctx.db.restaurantBranch.findMany.mockResolvedValue([
      { id: 'branch-1', name: 'Main', timezone: 'UTC', businessDayCutoff: '00:00' },
    ] as never);
    ctx.db.restaurantStaffProfile.findMany.mockResolvedValue([
      { id: 'owner-1', displayName: 'Owner' },
    ] as never);
    const occurrence = {
      id: 'occ-1',
      status: 'MISSED',
      businessDate: new Date('2026-10-28'),
      dueAt: new Date('2026-10-28T10:00:00Z'),
      windowEndsAt: new Date('2026-10-28T11:00:00Z'),
      steps: [],
      evidence: [],
      verifications: [],
      escalationEvents: [],
      assignment: { template: { name: 'Closing checklist', category: 'Safety' } },
      templateVersion: { versionNumber: 1, steps: [] },
    };
    const caller = {
      listOccurrences: vi.fn(async ({ status }) => ({
        items: status === 'MISSED' ? [occurrence] : [],
      })),
      getOccurrence: vi.fn(async () => occurrence),
      waive: vi.fn(async () => ({})),
      verify: vi.fn(async () => ({})),
    };
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue(ctx);
    mocks.createCaller.mockReturnValue(caller);
    return {
      tree: await SopPage({ searchParams: Promise.resolve({ date: '2026-10-28' }) }),
      caller,
    };
  }
  it('uses a labelled, masked numeric PIN input and forwards it for sole-owner approval', async () => {
    const { tree, caller } = await readyBoard();
    render(tree);
    expect(screen.getByLabelText('Approver PIN')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Approver PIN')).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getByLabelText('Approver PIN')).toBeRequired();
    const form = new FormData();
    for (const [key, value] of Object.entries({
      intent: 'waive',
      occurrenceId: 'occ-1',
      actorStaffProfileId: 'owner-1',
      approvingStaffProfileId: 'owner-1',
      approvingPin: '4821',
      reason: 'Emergency',
    }))
      form.set(key, value);
    await tree.props.action(form);
    expect(caller.waive).toHaveBeenCalledWith({
      occurrenceId: 'occ-1',
      actorStaffProfileId: 'owner-1',
      approvingStaffProfileId: 'owner-1',
      approvingPin: '4821',
      reason: 'Emergency',
    });
  });
  it('forwards own-work verification PINs through the existing server action', async () => {
    const { tree, caller } = await readyBoard();
    const form = new FormData();
    for (const [key, value] of Object.entries({
      intent: 'verify',
      occurrenceId: 'occ-1',
      actorStaffProfileId: 'owner-1',
      approvalPin: '4821',
    }))
      form.set(key, value);
    await tree.props.action(form);
    expect(caller.verify).toHaveBeenCalledWith({
      occurrenceId: 'occ-1',
      actorStaffProfileId: 'owner-1',
      approvalPin: '4821',
      reason: undefined,
    });
  });
  it('renders the existing Studio board states for visual QA', async () => {
    const { tree } = await readyBoard();
    if (process.env.SOP_QA_OUTPUT) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { renderToStaticMarkup } = await import('react-dom/server');
      const { createElement } = await import('react');
      await mkdir(process.env.SOP_QA_OUTPUT, { recursive: true });
      const variants = {
        ready: tree.props,
        review: { ...tree.props, selected: { ...tree.props.selected, status: 'SUBMITTED' } },
        disabled: { ...tree.props, action: undefined },
        empty: {
          ...tree.props,
          state: 'empty',
          selected: null,
          groups: tree.props.groups.map((group: object) => ({ ...group, items: [] })),
        },
        error: { state: 'error' },
        permission: { state: 'permission' },
        success: {
          ...tree.props,
          notice: { kind: 'success', text: 'SOP waived with co-authorization.' },
        },
        failure: {
          ...tree.props,
          notice: { kind: 'error', text: 'Invalid or locked approving credential.' },
        },
      };
      for (const [name, props] of Object.entries(variants))
        await writeFile(
          `${process.env.SOP_QA_OUTPUT}/${name}.html`,
          renderToStaticMarkup(createElement(tree.type, props))
        );
    }
    render(tree);
    expect(screen.getByRole('button', { name: 'Waive occurrence' })).toBeEnabled();
  });
});
