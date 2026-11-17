import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Connected path: the real staged page mounts the real form, which calls the real server
 * actions, which call the real authenticated router. Only the database is faked (stateful),
 * so removing the form mount or the action wiring fails these tests.
 */
const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), ctx: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  unstable_rethrow: () => undefined,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/server/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/trpc')>()),
  createTRPCContext: mocks.ctx,
}));
vi.mock('@/components/pharmacy/staged-medicine-export', () => ({
  StagedMedicineExport: () => null,
}));
import Page from '@/app/(app)/pharmacy/medicines/staged/page';
import { stageMigrationBatch } from './migration-staging-actions';

type Stored = Record<string, unknown> & { id: string };
function makeDb() {
  const state = {
    sources: [] as Stored[],
    batches: [] as Stored[],
    rows: [] as Stored[],
  };
  const db = {
    state,
    $transaction: async (run: (tx: unknown) => unknown) => run(db),
    user: { findUnique: async () => ({ organizationRole: null, permissionOverrides: [] }) },
    pharmacyBranch: {
      findFirst: async () => ({ id: 'branch_a' }),
      findMany: async () => [{ id: 'branch_a', name: 'Branch A' }],
    },
    pharmacyMigrationSource: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const source = { id: 'source_a', ...data };
        state.sources.push(source);
        return source;
      },
    },
    pharmacyMigrationBatch: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const batch = { id: 'batch_a', ...data };
        state.batches.push(batch);
        return batch;
      },
      update: async ({ data }: { data: Record<string, unknown> }) =>
        Object.assign(state.batches[0]!, data),
      count: async () => state.batches.length,
      findMany: async () =>
        state.batches.map((batch) => ({ ...batch, source: state.sources[0] })),
      findFirst: async () => ({ ...state.batches[0], source: state.sources[0] }),
    },
    pharmacyMigrationRow: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        data.forEach((row, index) => state.rows.push({ id: `row_${index + 1}`, ...row }));
        return { count: data.length };
      },
      findMany: async () => state.rows.map((row) => ({ ...row, exceptions: [] })),
      findFirst: async () => ({ ...state.rows[0], exceptions: [] }),
      count: async () => state.rows.length,
    },
    pharmacyMigrationException: {
      createMany: async () => ({ count: 0 }),
      groupBy: async () => [],
    },
  };
  return db;
}
let db = makeDb();
beforeEach(() => {
  vi.clearAllMocks();
  db = makeDb();
  mocks.ctx.mockImplementation(async () => ({
    db,
    entitlements: { organizationId: 'org_a', enabledModules: ['pharmacy-core'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user_a', organizationId: 'org_a', role: 'ADMIN', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  }));
});
afterEach(cleanup);

const CSV = 'Product,Pack,Qty\nExample Tablet,30,29';
async function uploadOnRealPage() {
  render(await Page({ searchParams: Promise.resolve({}) }));
  const file = new File([CSV], 'legacy.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(CSV).buffer,
  });
  fireEvent.change(screen.getByLabelText('Source file'), { target: { files: [file] } });
  await screen.findByLabelText('Quantity column counts');
}
async function stageAndReopen(unit: 'PACKS' | 'UNITS') {
  await uploadOnRealPage();
  fireEvent.change(screen.getByLabelText('Quantity column counts'), { target: { value: unit } });
  fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
  await waitFor(() => expect(mocks.push).toHaveBeenCalled());
  const url = new URL(mocks.push.mock.calls[0]![0] as string, 'http://x');
  cleanup();
  render(
    await Page({
      searchParams: Promise.resolve(Object.fromEntries(url.searchParams.entries())),
    })
  );
}

describe('staged page → server action → router → review (connected)', () => {
  it('mounts the staging form on the real page and blocks staging without a choice', async () => {
    await uploadOnRealPage();
    expect(screen.getByLabelText('Quantity column counts')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Stage for review' })).toBeDisabled();
    expect(db.state.batches).toHaveLength(0);
  });
  it('rejects a missing choice at the action and router, writing nothing', async () => {
    const result = await stageMigrationBatch({
      branchId: 'branch_a',
      fileName: 'legacy.csv',
      content: Buffer.from(CSV).toString('base64'),
      mapping: { product: 0, pack: 1, quantity: 2 },
    } as never);
    expect(result).toMatchObject({ error: expect.stringContaining('quantity choice') });
    expect(db.state.sources).toHaveLength(0);
    expect(db.state.batches).toHaveLength(0);
  });
  it('stages PACKS 29 × 30 as 870 units and reviews it', async () => {
    await stageAndReopen('PACKS');
    expect(db.state.batches[0]).toMatchObject({ quantityUnit: 'PACKS' });
    expect(db.state.rows[0]).toMatchObject({ quantityCanonical: BigInt(870) });
    expect(screen.getAllByText('29 packs × 30 = 870 units').length).toBeGreaterThan(0);
  });
  it('preserves UNITS without inventing packs and reviews it', async () => {
    await stageAndReopen('UNITS');
    expect(db.state.batches[0]).toMatchObject({ quantityUnit: 'UNITS' });
    expect(db.state.rows[0]).toMatchObject({ quantityCanonical: BigInt(29) });
    expect(screen.getAllByText('29 units').length).toBeGreaterThan(0);
    expect(screen.queryByText(/packs ×/)).toBeNull();
  });
  it('shows a legacy batch with no recorded choice as a raw count', async () => {
    await stageAndReopen('UNITS');
    cleanup();
    db.state.batches[0]!.quantityUnit = null;
    render(
      await Page({
        searchParams: Promise.resolve({
          branchId: 'branch_a',
          sourceId: 'source_a',
          batchId: 'batch_a',
          rowId: 'row_1',
        }),
      })
    );
    expect(screen.getAllByText('29 (staged as raw count)').length).toBeGreaterThan(0);
    expect(screen.getByText('not recorded (staged as raw count)')).toBeTruthy();
  });
});
