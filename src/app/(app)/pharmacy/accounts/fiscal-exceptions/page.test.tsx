import { cleanup, render, screen, within } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FiscalExceptionRegister } from '@/lib/pharmacy/accounts/fiscal-exceptions';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('./access', () => ({ loadFiscalExceptionRegister: mocks.load }));
import Page from './page';
import Loading from './loading';
import ErrorState from './error';
import { fiscalExceptionHref, fiscalExceptionQuery } from './query';

const query = { branchId: 'branch-1', from: '2026-07-01', to: '2026-10-01' };
function register(): FiscalExceptionRegister {
  return {
    organizationId: 'org-1', branch: { id: 'branch-1', name: 'Main' },
    filters: { ...query, page: 0, pageSize: 50 }, configuredMode: 'OFF',
    readAt: '2026-10-01T00:00:00.000Z', coverage: 'UNKNOWN', hasMoreAtRead: true,
    pageCapReached: false, nextPage: 1,
    rows: [{ id: 'doc-1', localReference: 'LOCAL-001', kind: 'INVOICE', integratorMode: 'SANDBOX',
      status: 'QUEUED', attempts: 1, maxAttempts: 3, nextAttemptAt: null,
      createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z',
    }],
  };
}

// Returning the mock would register it as a Vitest cleanup callback.
beforeEach(() => { mocks.load.mockResolvedValue(register()); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('fiscal exception evidence page', () => {
  it('renders explicit configuration and recorded mode, bounded metadata and honest coverage', async () => {
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Fiscal exception evidence' })).toBeVisible();
    expect(screen.getByText('Configured: OFF')).toBeVisible();
    expect(screen.getByText('SANDBOX')).toBeVisible();
    expect(screen.getByText(/Coverage unknown/)).toBeVisible();
    expect(screen.getByText(/Total unknown/)).toHaveTextContent('Page capped');
    expect(screen.getByText(/CSV downloads re-read/)).toBeVisible();
    expect(screen.getByLabelText('Created before (UTC, exclusive)')).toHaveValue(query.to);
    const region = screen.getByRole('region', { name: 'Fiscal exception documents' });
    expect(region).toHaveAttribute('tabindex', '0');
    region.focus();
    expect(region).toHaveFocus();
    expect(within(region).getByRole('rowheader')).toHaveTextContent('LOCAL-001');
    expect(within(region).getByText('1 / 3')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download page CSV' })).toHaveAttribute('href',
      fiscalExceptionHref(register().filters, true));
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute('href',
      fiscalExceptionHref({ ...register().filters, page: 1 }));
    expect(screen.queryByRole('button', { name: /retry|send|dispatch/i })).not.toBeInTheDocument();
  });

  it('keeps empty evidence unknown and offers filter guidance', async () => {
    mocks.load.mockResolvedValue({ ...register(), rows: [], hasMoreAtRead: false, nextPage: null });
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(screen.getByText(/No matching current exceptions/)).toHaveTextContent('Missing evidence is unknown');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Download page CSV' })).toBeVisible();
  });

  it('stops navigation at the cap and asks for a narrower window', async () => {
    mocks.load.mockResolvedValue({ ...register(), filters: { ...register().filters, page: 19 },
      pageCapReached: true, nextPage: null });
    render(await Page({ searchParams: Promise.resolve({ ...query, page: '19' }) }));
    expect(screen.getByText(/Pagination cap reached/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Previous page' })).toHaveAttribute('href',
      fiscalExceptionHref({ ...register().filters, page: 18 }));
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'BAD_REQUEST', 'INTERNAL_SERVER_ERROR'] as const)
  ('handles %s without rendering raw errors or an export link', async (code) => {
    mocks.load.mockRejectedValue(new TRPCError({ code, message: 'secret SQL and provider payload' }));
    render(await Page({ searchParams: Promise.resolve(query) }));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByText(/secret SQL/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download page CSV' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download page CSV' })).toBeDisabled();
    expect(screen.getByLabelText('Active branch ID')).toHaveValue(query.branchId);
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
  });

  it.each(['organizationId', '__proto__', 'constructor', 'toString'])
  ('rejects unsupported URL key %s with a safe error and no read or export', async (key) => {
    render(await Page({ searchParams: Promise.resolve({ ...query, [key]: 'foreign' }) }));
    expect(mocks.load).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an active branch ID');
    expect(screen.queryByRole('link', { name: 'Download page CSV' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download page CSV' })).toBeDisabled();
    expect(screen.getByLabelText('Active branch ID')).toHaveValue(query.branchId);
  });

  it('provides loading and recoverable error states', () => {
    const loading = render(<Loading />);
    expect(screen.getByRole('status', { name: 'Loading fiscal exception evidence' })).toBeVisible();
    loading.unmount();
    render(<ErrorState reset={vi.fn()} />);
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('local URL interpretation', () => {
  it.each(['tenantId', '__proto__', 'constructor', 'toString'])('rejects unknown URL key %s', (key) => {
    expect(() => fiscalExceptionQuery({ ...query, [key]: 'foreign' })).toThrow(expect.objectContaining({
      code: 'BAD_REQUEST',
    }));
  });

  it('preserves duplicates and malformed fields for strict reader rejection', () => {
    expect(fiscalExceptionQuery({ ...query, page: ['1', '2'] })).toMatchObject({
      page: NaN,
    });
    expect(fiscalExceptionQuery({ ...query, branchId: ['one', 'two'] }).branchId).toEqual(['one', 'two']);
    expect(fiscalExceptionQuery({ ...query, pageSize: '1e2' }).pageSize).toBeNaN();
    expect(fiscalExceptionQuery({ ...query, page: '' }).page).toBeNaN();
  });
});
