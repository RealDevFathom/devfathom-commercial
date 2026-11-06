import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  caller: vi.fn(),
  module: vi.fn(),
  form: vi.fn(),
  writeOff: vi.fn(),
  release: vi.fn(),
  redirect: vi.fn(),
  assigned: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.module }));
vi.mock('@/server/routers/pharmacy-inventory', () => ({
  admittedInventoryBranchIds: mocks.assigned,
  pharmacyInventoryRouter: { createCaller: mocks.caller },
}));
vi.mock('./break-pack-form', () => ({
  BreakPackForm: (props: unknown) => {
    mocks.form(props);
    return null;
  },
}));
// Async server-component verification belongs to the migrated DB/browser lane.
vi.mock('@/components/camera/cold-chain-camera-section', () => ({
  ColdChainCameraSection: () => null,
}));

import PharmacyInventoryPage from './page';

const branch = { id: 'branch-main', name: 'Main', city: 'Karachi' };
const location = {
  id: 'rack',
  branchId: branch.id,
  name: 'Rack',
  kind: 'RACK_BIN',
  active: true,
  coldChain: false,
};
const available = {
  stockLocationId: location.id,
  disposition: 'AVAILABLE',
  onHandUnits: 34,
  sealedPacks: 3,
  looseUnits: 4,
  location,
};
const lot = {
  id: 'lot-a',
  supplierName: 'Supplier',
  unitsPerPack: 10,
  receivedAt: new Date('2026-01-01'),
  batch: {
    medicineId: 'medicine',
    batchNumber: 'B-100',
    state: 'ACTIVE',
    expiresAt: new Date('2099-01-01'),
    medicine: { productName: 'Medicine A', brandName: null },
  },
  balances: [available],
};
const lots = vi.fn();
const nearExpiry = vi.fn();
let ctx: ReturnType<typeof makeContext>;

function makeContext() {
  return {
    session: { user: { id: 'user', status: 'ACTIVE' } },
    organization: { id: 'org', isDemo: false },
    entitlements: {},
    db: {
      pharmacyBranch: { findMany: vi.fn().mockResolvedValue([branch]) },
      pharmacyStockLocation: { findMany: vi.fn().mockResolvedValue([location]) },
      pharmacyInventoryLot: { findMany: lots },
      pharmacyInventoryCount: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyInterbranchTransfer: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyRecallNotice: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyStockSignal: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyTemperatureLog: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

async function show() {
  return render(
    await PharmacyInventoryPage({ searchParams: Promise.resolve({ branch: branch.id }) })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx = makeContext();
  mocks.actor.mockResolvedValue(ctx);
  mocks.context.mockResolvedValue(ctx);
  mocks.module.mockReturnValue(true);
  mocks.assigned.mockResolvedValue(new Set([branch.id]));
  mocks.caller.mockReturnValue({
    nearExpiryBoard: nearExpiry,
    temperatureZoneStatuses: vi.fn().mockResolvedValue([]),
    writeOff: mocks.writeOff,
    releaseQuarantinedPart: mocks.release,
  });
  mocks.writeOff.mockResolvedValue({});
  mocks.release.mockResolvedValue({});
  nearExpiry.mockResolvedValue([]);
  lots.mockResolvedValue([lot]);
});

describe('Quarantine resolution forms', () => {
  it.each(['AVAILABLE', 'QUARANTINE'])(
    'submits the selected %s position with write-off custody evidence',
    async (disposition) => {
      lots.mockResolvedValue([{ ...lot, balances: [{ ...available, disposition }] }]);
      ctx.db.user.findMany.mockResolvedValue([
        { id: 'witness', name: 'Witness', title: 'Pharmacist' },
      ]);
      await show();
      const form = screen.getByRole('button', { name: 'Record write-off' }).closest('form')!;
      expect(within(form).getByRole('combobox', { name: 'Lot' })).toHaveValue(
        `${lot.id}:${location.id}:${disposition}`
      );
      fireEvent.change(within(form).getByLabelText('Units'), { target: { value: '10' } });
      fireEvent.change(within(form).getByLabelText('Evidence reference'), {
        target: { value: 'certificate-1' },
      });
      fireEvent.change(within(form).getByLabelText('Reason'), {
        target: { value: 'Damaged stock' },
      });
      fireEvent.submit(form);
      await waitFor(() =>
        expect(mocks.writeOff).toHaveBeenCalledExactlyOnceWith({
          branchId: branch.id,
          inventoryLotId: lot.id,
          stockLocationId: location.id,
          disposition,
          units: 10,
          witnessId: 'witness',
          reason: 'Damaged stock',
          evidenceRef: 'certificate-1',
          idempotencyKey: expect.stringMatching(/^ui-writeoff:/),
        })
      );
      await waitFor(() => expect(mocks.redirect).toHaveBeenCalled());
    }
  );

  it('submits a manual hold release even when no available stock remains', async () => {
    lots.mockResolvedValue([{ ...lot, balances: [{ ...available, disposition: 'QUARANTINE' }] }]);
    await show();
    const form = screen.getByRole('button', { name: 'Release manual hold' }).closest('form')!;
    fireEvent.change(within(form).getByLabelText('Units'), { target: { value: '10' } });
    fireEvent.change(within(form).getByLabelText('Clearance reason'), {
      target: { value: 'Inspection passed' },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith({
        branchId: branch.id,
        inventoryLotId: lot.id,
        stockLocationId: location.id,
        units: 10,
        reason: 'Inspection passed',
        idempotencyKeyPrefix: expect.stringMatching(/^ui-quarantine-release:/),
      })
    );
    await waitFor(() => expect(mocks.redirect).toHaveBeenCalled());
  });

  it.each(['RECALLED', 'QUARANTINED'])('hides manual release for a %s batch', async (state) => {
    lots.mockResolvedValue([
      {
        ...lot,
        batch: { ...lot.batch, state },
        balances: [{ ...available, disposition: 'QUARANTINE' }],
      },
    ]);
    await show();
    expect(screen.queryByRole('button', { name: 'Release manual hold' })).not.toBeInTheDocument();
  });

  it('keeps available and quarantine options distinct at the same location', async () => {
    lots.mockResolvedValue([
      {
        ...lot,
        balances: [available, { ...available, disposition: 'QUARANTINE' }],
      },
    ]);
    ctx.db.user.findMany.mockResolvedValue([
      { id: 'witness', name: 'Witness', title: 'Pharmacist' },
    ]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await show();
      const form = screen.getByRole('button', { name: 'Record write-off' }).closest('form')!;
      expect(
        within(form)
          .getAllByRole('option')
          .map((option) => (option as HTMLOptionElement).value)
      ).toEqual([
        `${lot.id}:${location.id}:AVAILABLE`,
        `${lot.id}:${location.id}:QUARANTINE`,
        'witness',
      ]);
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    } finally {
      errors.mockRestore();
    }
  });
});
afterEach(cleanup);

describe('Inventory pack-action integration', () => {
  it('passes exact lot/location balances and preserves FEFO query and available totals', async () => {
    await show();
    expect(mocks.form.mock.calls[0][0]).toEqual({
      branchId: branch.id,
      inventoryLotId: lot.id,
      stockLocationId: location.id,
      medicineName: 'Medicine A',
      batchNumber: 'B-100',
      locationName: 'Rack',
      sealedPacks: 3,
      looseUnits: 4,
      unitsPerPack: 10,
      onHandUnits: 34,
      expiresAt: '2099-01-01T00:00:00.000Z',
      unavailableReason: null,
      observedAt: expect.any(Number),
    });
    expect(lots).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { organizationId: 'org', branchId: branch.id },
        orderBy: [{ batch: { expiresAt: 'asc' } }, { createdAt: 'asc' }],
      })
    );
    expect(screen.getByText('34 units · 3 sealed + 4 loose')).toBeVisible();
    expect(nearExpiry).toHaveBeenCalledExactlyOnceWith({ branchId: branch.id });
  });

  it.each(['RECALLED', 'QUARANTINED'])('disables batch state %s', async (state) => {
    lots.mockResolvedValue([{ ...lot, batch: { ...lot.batch, state } }]);
    await show();
    expect(mocks.form.mock.calls[0][0].unavailableReason).toBe(`Batch is ${state.toLowerCase()}.`);
  });

  it('excludes held and zero-unit balances from actions', async () => {
    lots.mockResolvedValue([
      {
        ...lot,
        balances: [
          { ...available, disposition: 'QUARANTINE' },
          { ...available, stockLocationId: 'empty', onHandUnits: 0, sealedPacks: 0, looseUnits: 0 },
        ],
      },
    ]);
    await show();
    expect(mocks.form).not.toHaveBeenCalled();
    expect(screen.getByText(/No available lots yet/)).toBeVisible();
  });

  it('keeps an unreceived lot disabled', async () => {
    lots.mockResolvedValue([{ ...lot, receivedAt: null }]);
    await show();
    expect(mocks.form.mock.calls[0][0].unavailableReason).toBe('Stock has not been received.');
  });

  it('keeps an inactive location disabled', async () => {
    lots.mockResolvedValue([
      { ...lot, balances: [{ ...available, location: { ...location, active: false } }] },
    ]);
    await show();
    expect(mocks.form.mock.calls[0][0].unavailableReason).toBe('Stock location is inactive.');
  });

  it('preserves session denial without adding a role-based grant', async () => {
    ctx.session.user.status = 'INACTIVE';
    await show();
    expect(mocks.form.mock.calls[0][0].unavailableReason).toMatch(/account is no longer active/);
  });

  it('shows no action or inventory read without the module', async () => {
    mocks.module.mockReturnValue(false);
    await show();
    expect(screen.getByText('Inventory module unavailable')).toBeVisible();
    expect(mocks.form).not.toHaveBeenCalled();
    expect(lots).not.toHaveBeenCalled();
  });
});

describe('expiry advice entry point (DEV-594)', () => {
  /** The viewer's role grants, as the ABAC lookup reads them. */
  function grants(role: 'ADMIN' | 'EMPLOYEE', capabilities: string[]) {
    Object.assign(ctx.session.user, { role });
    Object.assign(ctx.db.user, {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
        },
        permissionOverrides: [],
      }),
    });
  }

  it('links the owner to expiry advice for the working branch', async () => {
    grants('ADMIN', ['pharmacy:inventory', 'reports:operational', 'reports:financial']);
    await show();
    expect(screen.getByRole('link', { name: 'Open expiry advice' })).toHaveAttribute(
      'href',
      '/pharmacy/reports?branch=branch-main'
    );
  });

  it('offers no link to a non-owner, even with both report grants', async () => {
    grants('EMPLOYEE', ['pharmacy:inventory', 'reports:operational', 'reports:financial']);
    await show();
    expect(screen.queryByRole('link', { name: 'Open expiry advice' })).not.toBeInTheDocument();
  });

  it('offers no link to an owner without financial reports', async () => {
    grants('ADMIN', ['pharmacy:inventory', 'reports:operational']);
    await show();
    expect(screen.queryByRole('link', { name: 'Open expiry advice' })).not.toBeInTheDocument();
  });
});

describe('DEV-660 — only assigned branches are offered', () => {
  const other = { id: 'branch-other', name: 'Other', city: 'Lahore' };

  it('explains a missing assignment and reads no stock', async () => {
    mocks.assigned.mockResolvedValue(new Set());
    await show();
    expect(screen.getByText('Branch assignment required')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open branch assignments' })).toBeNull();
    expect(nearExpiry).not.toHaveBeenCalled();
    expect(lots).not.toHaveBeenCalled();
  });

  it('links an ADMIN session that is admitted to no branch to the assignment page', async () => {
    mocks.assigned.mockResolvedValue(new Set());
    Object.assign(ctx.session.user, { role: 'ADMIN' });
    await show();
    expect(screen.getByRole('link', { name: 'Open branch assignments' })).toHaveAttribute(
      'href',
      '/pharmacy/settings/branches'
    );
    expect(nearExpiry).not.toHaveBeenCalled();
  });

  it('reads no stock directly when the gated branch read refuses', async () => {
    nearExpiry.mockRejectedValue(new Error('Branch is outside your scope.'));
    await expect(
      PharmacyInventoryPage({ searchParams: Promise.resolve({ branch: branch.id }) })
    ).rejects.toThrow('Branch is outside your scope.');
    expect(lots).not.toHaveBeenCalled();
  });

  it('offers to receive a transfer only at its destination branch', async () => {
    ctx.db.pharmacyBranch.findMany.mockResolvedValue([branch, other]);
    const lines = [{ id: 'line-1', quantityUnits: 5, receivedUnits: 0 }];
    ctx.db.pharmacyInterbranchTransfer.findMany.mockResolvedValue([
      {
        id: 'outbound',
        fromBranchId: branch.id,
        toBranchId: other.id,
        status: 'DISPATCHED',
        lines,
      },
      { id: 'inbound', fromBranchId: other.id, toBranchId: branch.id, status: 'DISPATCHED', lines },
    ]);
    await show();
    const receive = screen.getAllByRole('button', { name: 'Receive remaining' });
    expect(receive).toHaveLength(1);
    const form = receive[0]!.closest('form')!;
    expect(form.querySelector('input[name="transferId"]')).toHaveValue('inbound');
    expect(form.querySelector('input[name="branchId"]')).toHaveValue(branch.id);
  });

  it('opens an assigned branch instead of an unassigned one named in the URL', async () => {
    ctx.db.pharmacyBranch.findMany.mockResolvedValue([branch, other]);
    render(await PharmacyInventoryPage({ searchParams: Promise.resolve({ branch: other.id }) }));
    expect(nearExpiry).toHaveBeenCalledExactlyOnceWith({ branchId: branch.id });
    const branchSelect = screen.getByRole('combobox', { name: 'Branch' });
    expect(within(branchSelect).queryByRole('option', { name: /Other/ })).toBeNull();
    expect(within(branchSelect).getByRole('option', { name: /Main/ })).toBeInTheDocument();
  });
});
