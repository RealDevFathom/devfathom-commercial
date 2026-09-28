import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), context: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));

import {
  originalCount,
  readImportedStock,
  type ImportedStockQuery,
} from '@/lib/pharmacy/imported-stock';
import InventoryError from '../error';
import InventoryLoading from '../loading';
import ImportedStockPage from './page';

const row = {
  id: 'row-a',
  sourceId: 'source-a',
  batchId: 'batch-a',
  rowNumber: 1,
  productName: 'ANAPRO HAIR SPRAY',
  originalQty: '1.0000',
  originalPackQty: '1.000000',
  originalPackUnits: '1',
};
function context() {
  return {
    session: {
      user: { id: 'user-a', organizationId: 'org-a', status: 'ACTIVE', role: 'EMPLOYEE' },
    },
    organization: { id: 'org-a' },
    support: null,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-inventory'] },
    db: new Proxy(
      {},
      {
        get: (_, key) => {
          if (key === '$queryRaw') return mocks.query;
          throw new Error(`Unexpected database operation: ${String(key)}`);
        },
      }
    ),
  };
}
let ctx: ReturnType<typeof context>;
let assertions = 0;
beforeEach(() => {
  vi.resetAllMocks();
  ctx = context();
  mocks.actor.mockResolvedValue(ctx);
  mocks.context.mockResolvedValue(ctx);
  mocks.query
    .mockResolvedValueOnce([{ importedRows: 18933, reportedStockRows: 6043, matchingRows: 101 }])
    .mockResolvedValueOnce([row]);
});
afterEach(() => {
  assertions += expect.getState().assertionCalls;
  cleanup();
});
afterAll(() => {
  console.info(`WHA-1559 focused assertions: ${assertions}`);
});

async function show(query: ImportedStockQuery = {}) {
  return render(await ImportedStockPage({ searchParams: Promise.resolve(query) }));
}

describe('Original stock references', () => {
  it.each([
    '1.0000',
    '1.000000',
    '0.00000000000000000001',
    '9007199254740993.0000',
    '-1.2500',
    '+001.50',
    '.5',
    '1.',
    '0',
    '-0.000',
    ' 1.2500 ',
    '\t1.2500\n',
  ])('preserves %j byte-for-byte', (value) => {
    expect(originalCount(value)).toBe(value);
  });
  it.each([
    null,
    undefined,
    '',
    '  ',
    'NaN',
    'Infinity',
    '1e3',
    '1,000',
    '1 unit',
    '--1',
    1,
    {},
    ['1'],
  ])('keeps invalid/absent %j unknown', (value) => {
    expect(originalCount(value)).toBeNull();
  });

  it('projects safe scalar fields; positive QTY totals use sign/digits without numeric casts', async () => {
    const data = await readImportedStock({});
    expect(data?.rows).toEqual([row]);
    expect(data?.reportedStockRows).toBe(6043);
    expect(mocks.context).toHaveBeenCalledExactlyOnceWith({
      session: ctx.session,
      organization: ctx.organization,
      support: null,
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    const [totals, rows] = mocks.query.mock.calls.map(([query]) => query);
    expect(totals.sql).toContain("jsonb_typeof(r.\"rawPayload\"->'QTY') = 'string'");
    expect(totals.sql).toContain("!~ '^[[:space:]]*-'");
    expect(totals.sql).toContain("~ '[1-9]'");
    expect(totals.sql).not.toMatch(/::(?:numeric|decimal|float|double)|round\(|sum\(/i);
    const pattern = totals.values.find(
      (value: unknown) => typeof value === 'string' && value.startsWith('^[[:space:]]')
    );
    // Exercise the decimal grammar carried to PostgreSQL (POSIX whitespace in SQL).
    const decimal = new RegExp(pattern.replaceAll('[[:space:]]', '\\s'));
    expect(
      ['1.0000', '.0001', '9007199254740993.0000', '0', '-1.5', ' 1.00 '].every((value) =>
        decimal.test(value)
      )
    ).toBe(true);
    expect(['', ' ', '1e3', 'NaN', '1,000', 'x1'].every((value) => !decimal.test(value))).toBe(
      true
    );
    for (const query of [totals, rows]) {
      expect(query.sql.trim()).toMatch(/^SELECT\b/);
      expect(query.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|UPSERT|CALL|CREATE|ALTER|DROP)\b/i);
      expect(query.sql).not.toMatch(
        /supplier|customer|cost|StockValue|saleprice|purprice|UnitPrice|sourceKey|quantityCanonical/i
      );
      expect(query.sql).not.toMatch(/r\.\*|r\."rawPayload"(?!\s*->)/);
      expect(query.values.filter((value: unknown) => value === 'org-a')).toHaveLength(2);
      expect(query.sql).toContain('b."organizationId" = r."organizationId"');
      expect(query.sql).toContain("b.status = 'PROFILED' AND r.\"targetModelKey\" = 'med.product'");
    }
    expect(rows.sql).toContain('LIMIT ? OFFSET ?');
    expect(rows.values.slice(-2)).toEqual([50, 0]);
  });

  it('keeps invalid and blank values unknown after reading; never turns them into zero', async () => {
    mocks.query
      .mockReset()
      .mockResolvedValueOnce([{ importedRows: 1, reportedStockRows: 0, matchingRows: 1 }])
      .mockResolvedValueOnce([
        { ...row, originalQty: '', originalPackQty: 'invalid', originalPackUnits: null },
      ]);
    const data = await readImportedStock({});
    expect(data?.rows[0]).toEqual({
      ...row,
      originalQty: null,
      originalPackQty: null,
      originalPackUnits: null,
    });
  });
});

describe('Read permission and tenant isolation', () => {
  it.each([
    'no actor',
    'no user ID',
    'inactive',
    'revoked',
    'missing status',
    'actor tenant mismatch',
  ])('denies %s before creating context or reading rows', async (scenario) => {
    if (scenario === 'no actor') mocks.actor.mockResolvedValue(null);
    if (scenario === 'no user ID') ctx.session.user.id = '';
    if (scenario === 'inactive') ctx.session.user.status = 'INACTIVE';
    if (scenario === 'revoked') Object.assign(ctx.session.user, { sessionRevoked: true });
    if (scenario === 'missing status') ctx.session.user.status = '';
    if (scenario === 'actor tenant mismatch') ctx.session.user.organizationId = 'org-other';
    expect(await readImportedStock({})).toBeNull();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([
    'module disabled',
    'entitlement mismatch',
    'organization mismatch',
    'session tenant mismatch',
    'session user mismatch',
  ])('denies %s before imported-data access', async (scenario) => {
    const resolved = context();
    if (scenario === 'module disabled') resolved.entitlements.enabledModules = [];
    if (scenario === 'entitlement mismatch') resolved.entitlements.organizationId = 'org-other';
    if (scenario === 'organization mismatch') resolved.organization.id = 'org-other';
    if (scenario === 'session tenant mismatch') resolved.session.user.organizationId = 'org-other';
    if (scenario === 'session user mismatch') resolved.session.user.id = 'user-other';
    mocks.context.mockResolvedValue(resolved);
    expect(await readImportedStock({})).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('ignores caller-supplied tenant/source identities and binds both queries to request tenant', async () => {
    await readImportedStock({
      organizationId: 'org-other',
      sourceId: 'source-private',
      batchId: 'batch-private',
    } as ImportedStockQuery);
    for (const [query] of mocks.query.mock.calls) {
      expect(query.values.filter((value: unknown) => value === 'org-a')).toHaveLength(2);
      expect(query.values).not.toEqual(
        expect.arrayContaining(['org-other', 'source-private', 'batch-private'])
      );
    }
  });
});

describe('Search, pagination and rendering', () => {
  it('binds literal search, clamps out-of-range pages, preserves stable ordering and search links', async () => {
    await show({ q: "  spray%'_  ", page: '999999999' });
    const [totals, rows] = mocks.query.mock.calls.map(([query]) => query);
    expect(totals.values).toContain("spray%'_");
    expect(rows.values).toContain("spray%'_");
    expect(rows.sql).toContain('strpos(lower(coalesce(r."productName", \'\')), lower(?)) > 0');
    expect(rows.sql).not.toContain("spray%'_");
    expect(rows.sql).toContain('ORDER BY r."batchId", r."rowNumber", r.id');
    expect(rows.values.slice(-2)).toEqual([50, 100]);
    expect(screen.getByRole('searchbox')).toHaveValue("spray%'_");
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      `/pharmacy/inventory/imports?${new URLSearchParams({ q: "spray%'_", page: '2' })}`
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText(/101 matching rows · Page 3 of 3/)).toBeVisible();
    expect(screen.getByRole('searchbox').closest('form')).toHaveAttribute('method', 'get');
    expect(screen.getByRole('searchbox').closest('form')).not.toContainHTML('name="page"');
  });
  it.each(['0', '-1', '2.5', '2junk', 'Infinity', '9999999999', ['2', '3']])(
    'bounds malformed page %j to first page',
    async (page) => {
      const data = await readImportedStock({ page, q: 'a'.repeat(161) });
      expect(data?.page).toBe(1);
      expect(data?.search).toHaveLength(160);
      expect(mocks.query.mock.calls[1][0].values.slice(-2)).toEqual([50, 0]);
    }
  );
  it('renders exact original counts and identity for a non-financial role, with truthful totals/status', async () => {
    await show();
    expect(screen.getByRole('heading', { level: 1, name: 'Imported stock' })).toBeVisible();
    for (const name of [
      'Original QTY',
      'Original PackQty',
      'Original PackUnits',
      'Source row identity',
      'Verification status',
    ]) {
      expect(screen.getByRole('columnheader', { name })).toBeVisible();
    }
    for (const value of [
      'ANAPRO HAIR SPRAY',
      '1.0000',
      '1.000000',
      '1',
      'Source: source-a',
      'Import batch: batch-a',
      'Source row: 1',
      'Row ID: row-a',
      '18,933',
      '6,043',
    ]) {
      expect(screen.getByText(value)).toBeVisible();
    }
    expect(screen.getByText(/They are not available-to-sell balances/)).toBeVisible();
    expect(
      screen.getByText(
        /Totals count source rows, not distinct medicines or verified sellable units/
      )
    ).toBeVisible();
    expect(screen.getByRole('cell', { name: 'Awaiting verification' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/pharmacy/inventory/imports?q=&page=2'
    );
    expect(screen.getByRole('link', { name: 'Back to Inventory' })).toHaveAttribute(
      'href',
      '/pharmacy/inventory'
    );
    expect(
      screen.queryByText(/cost|StockValue|supplier|customer|MRP|publish|approve/i)
    ).not.toBeInTheDocument();
  });
  it('renders unknown counts and treats imported names as text', async () => {
    mocks.query
      .mockReset()
      .mockResolvedValueOnce([{ importedRows: 1, reportedStockRows: 0, matchingRows: 1 }])
      .mockResolvedValueOnce([
        {
          ...row,
          productName: '<script>private()</script>',
          originalQty: '',
          originalPackQty: 'NaN',
          originalPackUnits: null,
        },
      ]);
    const { container } = await show();
    expect(screen.getAllByRole('cell', { name: 'Unknown' })).toHaveLength(3);
    expect(screen.getByText('<script>private()</script>')).toBeVisible();
    expect(container.querySelector('script')).toBeNull();
  });
  it.each([0, 3])(
    'renders empty state for %i imported rows without claiming verified stock',
    async (importedRows) => {
      mocks.query
        .mockReset()
        .mockResolvedValueOnce([{ importedRows, reportedStockRows: 0, matchingRows: 0 }])
        .mockResolvedValueOnce([]);
      await show({ q: importedRows ? 'missing' : '' });
      expect(
        screen.getByText(
          importedRows ? /No imported medicine names match/ : /No completed medicine imports/
        )
      ).toBeVisible();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
      expect(screen.getByText(/Page 1 of 1/)).toBeVisible();
    }
  );
  it('renders permission denial without counts or search', async () => {
    ctx.entitlements.enabledModules = [];
    await show();
    expect(screen.getByRole('heading', { name: 'Inventory access required' })).toBeVisible();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('propagates read failure to inherited boundary; loading/error components provide recovery', async () => {
    mocks.query.mockReset().mockRejectedValueOnce(new Error('read unavailable'));
    await expect(ImportedStockPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'read unavailable'
    );
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const loading = render(<InventoryLoading />);
    expect(screen.getByRole('status', { name: 'Loading pharmacy inventory' })).toBeVisible();
    loading.unmount();
    const reset = vi.fn();
    render(<InventoryError reset={reset} />);
    expect(screen.getByText(/No stock was changed/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
  });
  it('keeps page read-only with one Inventory discovery link and no publication handlers', () => {
    const page = readFileSync('src/app/(app)/pharmacy/inventory/imports/page.tsx', 'utf8');
    const inventory = readFileSync('src/app/(app)/pharmacy/inventory/page.tsx', 'utf8');
    expect(page).not.toContain("'use server'");
    expect(page).not.toMatch(/method="post"|\.mutation\(|createCaller|publish|approve/);
    expect(inventory.match(/href="\/pharmacy\/inventory\/imports"/g)).toHaveLength(1);
  });
});
