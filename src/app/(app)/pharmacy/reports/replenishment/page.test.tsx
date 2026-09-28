import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { actor, context, branches, catalog, consoleProps } = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  branches: vi.fn(),
  catalog: vi.fn(),
  consoleProps: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: context }));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: { createCaller: () => ({ branches, catalog }) },
}));
vi.mock('./scenario-console', () => ({
  ScenarioConsole: (props: unknown) => {
    consoleProps(props);
    return <p>Scoped replenishment console</p>;
  },
}));
import Page from './page';

beforeEach(() => {
  vi.clearAllMocks();
  actor.mockResolvedValue({
    session: { user: { role: 'ADMIN' } },
    organization: { id: 'o1', askFathomEnabled: false },
    support: null,
  });
  context.mockResolvedValue({ session: { user: { role: 'ADMIN' } } });
  branches.mockResolvedValue({ organizationId: 'o1', branches: [{ id: 'b1', name: 'Main' }] });
  catalog.mockResolvedValue({ permissions: { operational: true, financial: true } });
});
afterEach(cleanup);

describe('Replenishment route', () => {
  it('loads ordinary Reports with resolved tenant context and no AskFathom dependency', async () => {
    render(await Page({ searchParams: Promise.resolve({ branch: 'b1' }) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Replenishment' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to reports' })).toHaveAttribute(
      'href',
      '/pharmacy/reports'
    );
    expect(context).toHaveBeenCalledWith(await actor.mock.results[0].value);
    expect(consoleProps).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'o1', initialBranchId: 'b1', financial: true })
    );
  });
  it.each(['foreign', ['b1', 'foreign'], ''])(
    'does not select an unauthorized or ambiguous branch %j',
    async (branch) => {
      render(await Page({ searchParams: Promise.resolve({ branch }) }));
      expect(consoleProps).toHaveBeenCalledWith(
        expect.objectContaining({ initialBranchId: '', invalidInitialBranch: true })
      );
    }
  );
  it('does not silently choose a branch when none was requested', async () => {
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(consoleProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialBranchId: '', invalidInitialBranch: false })
    );
  });
  it('keeps planning redacted for a non-owner even when catalog grants financial capability', async () => {
    context.mockResolvedValue({ session: { user: { role: 'PHARMACIST' } } });
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ financial: false }));
  });
  it('keeps planning redacted when financial capability is absent', async () => {
    catalog.mockResolvedValue({ permissions: { operational: true, financial: false } });
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(consoleProps).toHaveBeenCalledWith(expect.objectContaining({ financial: false }));
  });
  it.each(['actor', 'scope', 'catalog'])(
    'contains unavailable %s without leaking source errors',
    async (failure) => {
      if (failure === 'actor') actor.mockResolvedValue(null);
      if (failure === 'scope') branches.mockRejectedValue(new Error('private database error'));
      if (failure === 'catalog') catalog.mockRejectedValue(new Error('private permission error'));
      render(await Page({ searchParams: Promise.resolve({}) }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Report access, your session or source data is unavailable'
      );
      expect(screen.getByRole('button', { name: 'Retry report access' })).toBeVisible();
      expect(screen.queryByText(/private/)).not.toBeInTheDocument();
      expect(consoleProps).not.toHaveBeenCalled();
      if (failure === 'actor') expect(context).not.toHaveBeenCalled();
    }
  );
});
