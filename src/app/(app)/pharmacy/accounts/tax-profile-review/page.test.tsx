import { cleanup, render, screen, within } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaxProfileReviewDto } from '@/lib/pharmacy/accounts/tax-profile-review';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  can: vi.fn(),
  hasModule: vi.fn(),
  branches: vi.fn(),
  workspace: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: { createCaller: () => ({ workspace: mocks.workspace }) },
}));
vi.mock('@/server/audit', () => ({ recordAudit: mocks.audit }));

import Page from './page';
import { GET } from './export/route';

function context() {
  return {
    session: { user: { id: 'owner', organizationId: 'org', role: 'ADMIN', status: 'ACTIVE' } },
    organization: { id: 'org' },
    entitlements: { organizationId: 'org' },
    requestMeta: { ip: null, userAgent: null },
    db: { pharmacyBranch: { findMany: mocks.branches } },
  };
}
function profile(id: string, overrides: Partial<TaxProfileReviewDto> = {}): TaxProfileReviewDto {
  return {
    id,
    organizationId: 'org',
    branchId: 'branch',
    versionNumber: id === 'v1' ? 1 : 2,
    name: `Profile ${id}`,
    status: 'PUBLISHED',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    approvedAt: new Date('2026-01-01T00:00:00Z'),
    approvalReference: 'APPROVED',
    rules: [
      {
        id: `rule-${id}`,
        organizationId: 'org',
        profileVersionId: id,
        productClass: 'MEDICINE',
        pctHsCode: '3004',
        rate: id === 'v1' ? '0' : '0.123456',
        priceMode: 'INCLUSIVE',
        roundingScale: 2,
        sroReference: null,
        sroProvisional: true,
        exemptionCode: null,
      },
    ],
    ...overrides,
  };
}

let ctx: ReturnType<typeof context>;
let profiles: TaxProfileReviewDto[];
const selected = { branch: 'branch', before: 'v1', after: 'v2' };
const request = (query: Record<string, string> = selected) =>
  new Request(
    `http://localhost/pharmacy/accounts/tax-profile-review/export?${new URLSearchParams(query)}`
  );
const show = async (query = selected) =>
  render(await Page({ searchParams: Promise.resolve(query) }));
const noDownload = () =>
  expect(screen.queryByRole('link', { name: 'Download evidence CSV' })).toBeNull();

beforeEach(() => {
  vi.resetAllMocks();
  ctx = context();
  profiles = [profile('v1'), profile('v2')];
  mocks.actor.mockImplementation(async () => ({
    session: ctx.session,
    organization: ctx.organization,
  }));
  mocks.context.mockImplementation(async () => ctx);
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockReturnValue(true);
  mocks.branches.mockResolvedValue([{ id: 'branch', name: 'Main branch' }]);
  mocks.workspace.mockImplementation(async () => ({ taxProfiles: profiles }));
  mocks.audit.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('tax profile review page', () => {
  it('allows a solo ADMIN owner and links the exact selected evidence to a server export', async () => {
    await show();
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'reports:operational',
      'reports:financial',
    ]);
    expect(mocks.hasModule.mock.calls.map((call) => call[1])).toEqual([
      'pharmacy-finance',
      'pharmacy-reports',
    ]);
    expect(mocks.branches).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org', active: true } })
    );
    expect(mocks.workspace).toHaveBeenCalledWith({ branchId: 'branch' });
    expect(screen.getByRole('region', { name: 'Recorded tax rule differences' })).toHaveAttribute(
      'tabindex',
      '0'
    );
    expect(screen.getByRole('link', { name: 'Download evidence CSV' })).toHaveAttribute(
      'href',
      '/pharmacy/accounts/tax-profile-review/export?branch=branch&before=v1&after=v2'
    );
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    'pharmacy-finance',
    'pharmacy-reports',
    'reports:operational',
    'reports:financial',
    'role',
    'organization',
    'anonymous',
  ])('refuses missing %s before loading branch evidence', async (gate) => {
    if (gate.startsWith('pharmacy-'))
      mocks.hasModule.mockImplementation((_: unknown, key: string) => key !== gate);
    if (gate.startsWith('reports:'))
      mocks.can.mockImplementation(async (_: unknown, key: string) => key !== gate);
    if (gate === 'role') ctx.session.user.role = 'MEMBER';
    if (gate === 'organization') ctx.organization.id = 'foreign';
    if (gate === 'anonymous') mocks.actor.mockResolvedValue(null);
    await show();
    expect(screen.getByText('Permission required')).toBeInTheDocument();
    noDownload();
    expect(mocks.branches).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it('never sends a foreign branch selection to the reader', async () => {
    await show({ ...selected, branch: 'foreign' });
    expect(mocks.workspace).toHaveBeenCalledWith({ branchId: 'branch' });
  });

  it('disables comparison without two approved profiles', async () => {
    profiles[1].status = 'DRAFT';
    await show();
    expect(screen.getByRole('button', { name: 'Compare recorded evidence' })).toBeDisabled();
    expect(screen.queryByRole('option', { hidden: true, name: /v2/ })).toBeNull();
    noDownload();
  });

  it.each(['DRAFT', 'RETIRED'] as const)(
    'does not export a selected %s version',
    async (status) => {
      profiles[1].status = status;
      await show();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      noDownload();
    }
  );

  it('shows an empty branch state without reading evidence', async () => {
    mocks.branches.mockResolvedValue([]);
    await show();
    expect(screen.getByText('No active branch')).toBeInTheDocument();
    noDownload();
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it('keeps export disabled after a reader failure', async () => {
    mocks.workspace.mockRejectedValue(new Error('Private database detail'));
    await show();
    expect(screen.getByText(/Tax profile evidence could not load/)).toBeInTheDocument();
    expect(screen.queryByText('Private database detail')).toBeNull();
    noDownload();
  });

  it.each([null, 'NEW-EXEMPTION'])(
    'shows before and after exemption evidence (%s)',
    async (after) => {
      profiles[0].rules[0].exemptionCode = 'OLD-EXEMPTION';
      profiles[1].rules[0].exemptionCode = after;
      await show();
      const row = screen.getByText('CHANGED').closest('tr')!;
      const cells = within(row).getAllByRole('cell');
      expect(cells[6]).toHaveTextContent('OLD-EXEMPTION');
      expect(cells[7]).toHaveTextContent(after ?? 'None recorded');
    }
  );

  it('explains no rule differences while retaining the export', async () => {
    profiles[1].rules[0].rate = '0';
    await show();
    expect(screen.getByText('No recorded rule differences.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download evidence CSV' })).toBeInTheDocument();
  });

  it('renders recorded HTML as text', async () => {
    profiles[1].rules[0].exemptionCode = '<img src=x onerror=alert(1)>';
    await show();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('tax profile evidence export', () => {
  it('rechecks access and records actor, tenant, branch, selection, time and outcome', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(await response.text()).toContain('"0.123456"');
    expect(mocks.workspace).toHaveBeenCalledWith({ branchId: 'branch' });
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        organizationId: 'org',
        actorId: 'owner',
        action: 'pharmacy.taxProfileReview.export',
        outcome: 'SUCCESS',
        statusCode: 200,
        metadata: expect.objectContaining({
          branchId: 'branch',
          beforeVersionId: 'v1',
          afterVersionId: 'v2',
          attemptedAt: expect.any(String),
        }),
      }),
      ctx.db
    );
  });

  it.each([
    'pharmacy-finance',
    'pharmacy-reports',
    'reports:operational',
    'reports:financial',
    'role',
    'organization',
  ])('independently rejects an export without %s', async (gate) => {
    if (gate.startsWith('pharmacy-'))
      mocks.hasModule.mockImplementation((_: unknown, key: string) => key !== gate);
    if (gate.startsWith('reports:'))
      mocks.can.mockImplementation(async (_: unknown, key: string) => key !== gate);
    if (gate === 'role') ctx.session.user.role = 'MEMBER';
    if (gate === 'organization') ctx.organization.id = 'foreign';
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILURE', statusCode: 403 }),
      ctx.db
    );
  });

  it('rejects an unauthenticated direct download', async () => {
    mocks.actor.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(403);
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it('records a branch-scope refusal from the existing reader', async () => {
    mocks.workspace.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
    const response = await GET(request({ ...selected, branch: 'foreign' }));
    expect(response.status).toBe(404);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'FAILURE',
        metadata: expect.objectContaining({ branchId: 'foreign' }),
      }),
      ctx.db
    );
    expect(await response.text()).not.toContain('APPROVED');
  });

  it.each(['DRAFT', 'RETIRED', 'foreign-profile', 'foreign-rule', 'missing', 'duplicate'])(
    'refuses invalid selected evidence: %s',
    async (invalid) => {
      if (invalid === 'DRAFT' || invalid === 'RETIRED') profiles[1].status = invalid;
      if (invalid === 'foreign-profile') profiles[1].organizationId = 'foreign';
      if (invalid === 'foreign-rule') profiles[1].rules[0].organizationId = 'foreign';
      if (invalid === 'missing') profiles.pop();
      if (invalid === 'duplicate') profiles.push(profile('v2'));
      const response = await GET(request());
      expect(response.status).toBe(400);
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'FAILURE' }),
        ctx.db
      );
      expect(await response.text()).not.toContain('APPROVED');
    }
  );

  it('refuses repeated query keys without loading evidence', async () => {
    const response = await GET(new Request(`${request().url}&before=v2`));
    expect(response.status).toBe(400);
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it('exports no-change profile metadata and disclaimer', async () => {
    profiles[1].rules[0].rate = '0';
    const response = await GET(request());
    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain('"UNCHANGED"');
    expect(csv).toContain('"v1","v2"');
    expect(csv).toContain('Recorded configuration evidence only');
  });

  it('does not expose evidence when the reader fails', async () => {
    mocks.workspace.mockRejectedValue(new Error('Private database detail'));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('Private database detail');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILURE' }),
      ctx.db
    );
  });

  it('awaits the audit before releasing an evidence response', async () => {
    let finishAudit!: () => void;
    mocks.audit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAudit = resolve;
        })
    );
    let completed = false;
    const pending = GET(request()).then((response) => {
      completed = true;
      return response;
    });
    await vi.waitFor(() => expect(mocks.audit).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    finishAudit();
    expect((await pending).status).toBe(200);
  });

  it('withholds the CSV if the audit cannot persist', async () => {
    mocks.audit.mockRejectedValue(new Error('Audit unavailable'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('APPROVED');
  });
});

it('explains a finance refusal and who can grant access', async () => {
  mocks.workspace.mockRejectedValueOnce(
    new TRPCError({ code: 'FORBIDDEN', message: 'private detail' })
  );
  await show();
  expect(screen.getByText(/Ask your workspace owner for finance access/)).toBeVisible();
  expect(screen.queryByText(/private detail/)).toBeNull();
});
