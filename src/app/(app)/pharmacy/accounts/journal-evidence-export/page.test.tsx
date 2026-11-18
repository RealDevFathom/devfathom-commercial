import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  financialStatements: vi.fn(),
  can: vi.fn(),
  branches: vi.fn(),
}));

vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: { createCaller: () => ({ branches: mocks.branches }) },
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: mocks.resolveTenantActor,
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: {
    createCaller: () => ({ financialStatements: mocks.financialStatements }),
  },
}));

import Page from './page';

const valid = { branch: 'branch-1', from: '2026-10-01', to: '2026-10-26', page: '1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTenantActor.mockResolvedValue({
    session: { user: { id: 'owner-1', role: 'ADMIN' } },
    organization: { id: 'org-1' },
    support: null,
  });
  mocks.can.mockResolvedValue(true);
  mocks.branches.mockResolvedValue({ branches: [{ id: 'branch-1', name: 'Main pharmacy' }] });
  mocks.createTRPCContext.mockResolvedValue({
    session: { user: { id: 'owner-1', role: 'ADMIN' } },
    entitlements: { enabledModules: ['pharmacy-reports'] },
    db: {},
    requestMeta: { ip: null },
  });
  mocks.financialStatements.mockResolvedValue({
    from: new Date('2026-10-01T00:00:00Z'),
    to: new Date('2026-10-26T00:00:00Z'),
    page: 1,
    journalCount: 26,
    journal: Array.from({ length: 25 }, (_, index) => ({
      id: `entry-${index}`,
      sourceKind: 'SALE',
      sourceId: `sale-${index}`,
      description: 'Sale',
      currency: 'PKR',
      occurredAt: new Date('2026-10-25T12:00:00Z'),
      reversesEntryId: null,
      lines: [
        {
          id: `line-${index}`,
          accountCode: 'CASH',
          side: 'DEBIT',
          amountMinor: 2147483647,
          lotId: null,
        },
      ],
    })),
  });
});

describe('journal evidence export page', () => {
  it('does not read or expose export for a denied actor', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
    expect(html).toContain('Permission required');
    expect(html).not.toContain('Export this page (CSV)');
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it('does not read or expose export for invalid bounds', async () => {
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ ...valid, page: 'not-a-page' }) })
    );
    expect(html).toContain('Invalid input is not read or exported');
    expect(html).not.toContain('Export this page (CSV)');
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it('shows explicit partial coverage and export only after a successful authorized read', async () => {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
    expect(mocks.financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
      page: 1,
    });
    expect(html).toContain('Some entries are missing');
    expect(html).toContain('25 entries returned · page cap 25 · 26 entries counted');
    expect(html).toContain('Other activity may not be included');
    expect(html).toContain('Export this page (CSV)');
  });

  it('reads each picked day from midnight to midnight in the organisation zone and labels it so', async () => {
    mocks.createTRPCContext.mockResolvedValue({
      session: { user: { id: 'owner-1', role: 'ADMIN' } },
      organization: { id: 'org-1', timezone: 'Asia/Karachi' },
      entitlements: { enabledModules: ['pharmacy-reports'] },
      db: {},
      requestMeta: { ip: null },
    });
    const html = renderToStaticMarkup(
      await Page({
        searchParams: Promise.resolve({ ...valid, from: '2026-10-01', to: '2026-10-02' }),
      })
    );
    // 00:00 PKT on 1 Oct is 19:00 UTC on 30 Sep; a 00:30 PKT entry on 1 Oct falls inside.
    expect(mocks.financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-1',
      from: '2026-09-30T19:00:00.000Z',
      to: '2026-10-01T19:00:00.000Z',
      page: 1,
    });
    expect(html).toContain('From (midnight, PKT)');
    expect(html).toContain('Until (midnight, PKT, not included)');
    expect(html).not.toContain('5:00 AM');
  });

  it('does not read a window whose zone-converted span exceeds 92 days', async () => {
    mocks.createTRPCContext.mockResolvedValue({
      session: { user: { id: 'owner-1', role: 'ADMIN' } },
      organization: { id: 'org-1', timezone: 'Europe/London' },
      entitlements: { enabledModules: ['pharmacy-reports'] },
      db: {},
      requestMeta: { ip: null },
    });
    // 1 Aug to 1 Nov spans the October fall-back: 92 days plus one hour in London.
    const html = renderToStaticMarkup(
      await Page({
        searchParams: Promise.resolve({ ...valid, from: '2026-08-01', to: '2026-11-01' }),
      })
    );
    expect(html).toContain('Invalid input is not read or exported');
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it.each(['admin:access', 'reports:operational', 'reports:financial'])(
    'denies an ADMIN with a missing %s capability',
    async (denied) => {
      mocks.can.mockImplementation(async (_subject, action) => action !== denied);
      const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
      expect(html).toContain('Permission required');
      expect(html).not.toContain('Export this page (CSV)');
      expect(mocks.branches).not.toHaveBeenCalled();
      expect(mocks.financialStatements).not.toHaveBeenCalled();
    }
  );

  it('offers only authorized branch names and a GET submit button', async () => {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
    const root = document.createElement('div');
    root.innerHTML = html;
    const form = root.querySelector('form')!;
    expect(form.method).toBe('get');
    expect(form.getAttribute('action')).toBe('/pharmacy/accounts/journal-evidence-export');
    expect(form.querySelector('button')?.type).toBe('submit');
    expect(form.querySelector('select[name="branch"]')?.textContent).toContain('Main pharmacy');
    expect(form.querySelector('input[name="branch"]')).toBeNull();
  });

  it.each(['outside-organization', 'inactive-branch'])(
    'does not read or export an unlisted branch: %s',
    async (branch) => {
      const html = renderToStaticMarkup(
        await Page({ searchParams: Promise.resolve({ ...valid, branch }) })
      );
      expect(html).not.toContain('Export this page (CSV)');
      expect(mocks.financialStatements).not.toHaveBeenCalled();
    }
  );

  it('does not export if request context or entitlement resolution fails', async () => {
    mocks.createTRPCContext.mockRejectedValue(new Error('database unavailable'));
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
    expect(html).toContain('Entries could not load');
    expect(html).not.toContain('Export this page (CSV)');
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it('fails closed when the authorized branch list cannot be read', async () => {
    mocks.branches.mockRejectedValue(new Error('denied'));
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
    expect(html).toContain('Entries could not load');
    expect(html).not.toContain('Export this page (CSV)');
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it('suppresses export when the existing DTO read fails', async () => {
    mocks.financialStatements.mockRejectedValue(new Error('read failed'));
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
    expect(html).toContain('Entries could not load');
    expect(html).not.toContain('Export this page (CSV)');
  });
});
