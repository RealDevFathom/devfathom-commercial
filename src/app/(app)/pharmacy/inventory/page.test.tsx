import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  caller: vi.fn(),
  module: vi.fn(),
  form: vi.fn(),
  writeOff: vi.fn(),
  release: vi.fn(),
  createLocation: vi.fn(),
  acknowledgeRecall: vi.fn(),
  can: vi.fn(),
  redirect: vi.fn(),
  assigned: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.module }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
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
    requestMeta: { ip: '203.0.113.7' },
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

async function show(notice: { notice?: string; kind?: string } = {}) {
  return render(
    await PharmacyInventoryPage({ searchParams: Promise.resolve({ branch: branch.id, ...notice }) })
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
    createLocation: mocks.createLocation,
    acknowledgeRecall: mocks.acknowledgeRecall,
  });
  mocks.can.mockResolvedValue(true);
  mocks.createLocation.mockResolvedValue({});
  mocks.writeOff.mockResolvedValue({});
  mocks.release.mockResolvedValue({});
  nearExpiry.mockResolvedValue([]);
  lots.mockResolvedValue([lot]);
});

describe('physical count prerequisites', () => {
  function countCard() {
    return within(
      screen
        .getByRole('heading', { name: 'Physical count' })
        .closest('[data-slot="section-card"]')! as HTMLElement
    );
  }

  it.each([
    ['no received lots', []],
    ['depleted stock', [{ ...lot, balances: [{ ...available, onHandUnits: 0 }] }]],
    [
      'quarantined stock only',
      [{ ...lot, balances: [{ ...available, disposition: 'QUARANTINE' }] }],
    ],
  ])('explains unavailable stock with an existing location: %s', async (_state, rows) => {
    lots.mockResolvedValue(rows);
    await show();
    const card = countCard();
    expect(
      card.getByText(
        'No available received stock to count at this branch. Receive stock before starting a count.'
      )
    ).toBeVisible();
    expect(card.getByRole('link', { name: 'Receive stock' })).toHaveAttribute(
      'href',
      `/pharmacy/purchasing/receiving?branch=${branch.id}`
    );
    expect(card.queryByText(/create a location/i)).not.toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'Freeze count scope' })).not.toBeInTheDocument();
    expect(card.queryByText('0', { exact: true })).not.toBeInTheDocument();
  });

  it('explains a missing location only when the branch has none', async () => {
    ctx.db.pharmacyStockLocation.findMany.mockResolvedValue([]);
    lots.mockResolvedValue([]);
    await show();
    const card = countCard();
    expect(
      card.getByText(
        'No active stock location exists for this branch. Create a location in Locations, then receive stock before starting a count.'
      )
    ).toBeVisible();
    expect(card.getByRole('link', { name: 'Receive stock' })).toHaveAttribute(
      'href',
      `/pharmacy/purchasing/receiving?branch=${branch.id}`
    );
    expect(card.queryByRole('button', { name: 'Freeze count scope' })).not.toBeInTheDocument();
  });

  it('offers the count form when available stock and a location exist', async () => {
    await show();
    const card = countCard();
    expect(card.getByRole('button', { name: 'Freeze count scope' })).toBeVisible();
    expect(card.getByRole('option', { name: 'Medicine A · batch B-100 · Rack' })).toHaveValue(
      `${lot.id}:${location.id}`
    );
    expect(card.queryByRole('link', { name: 'Receive stock' })).not.toBeInTheDocument();
  });
});

describe('inventory success notice', () => {
  const css = readFileSync(join(__dirname, '../../../globals.css'), 'utf8');
  function themeVariables(theme: 'light' | 'dark') {
    const values = new Map<string, string>();
    for (const block of css.matchAll(/(?:^|\n)(:root|\[data-theme='dark'\])\s*\{([^}]+)\}/g)) {
      if (block[1] !== ':root' && theme !== 'dark') continue;
      for (const declaration of block[2]!.matchAll(/(--[\w-]+):\s*([^;]+);/g))
        values.set(declaration[1]!, declaration[2]!.trim());
    }
    return values;
  }
  function color(token: string, values: Map<string, string>): number[] {
    const value = values.get(token);
    if (!value) throw new Error(`Undefined notice color token ${token}`);
    const reference = /^var\((--[\w-]+)\)$/.exec(value);
    if (reference) return color(reference[1]!, values);
    const hex = /^#([\da-f]{6})$/i.exec(value)?.[1];
    if (!hex) throw new Error(`Unsupported notice color ${token}`);
    return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  }
  function luminance(rgb: number[]) {
    const linear = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  }
  it.each(['light', 'dark'] as const)(
    'meets 4.5:1 text contrast on real %s theme surfaces',
    async (theme) => {
      await show({ notice: 'Inventory action completed.', kind: 'success' });
      const notice = screen.getByText('Inventory action completed.');
      expect(notice).toHaveAttribute('role', 'status');
      const classes = notice.className.split(/\s+/);
      const foreground = classes.find((value) => /^text-success(?:-foreground)?$/.test(value));
      const background = classes.find((value) =>
        /^bg-success(?:-background)?(?:\/\d+)?$/.test(value)
      );
      if (!foreground || !background) throw new Error('Notice has no semantic success colors');
      const variables = themeVariables(theme);
      const text = color(foreground.replace('text-', '--'), variables);
      const [backgroundClass, opacity = '100'] = background.split('/');
      const tint = color(backgroundClass!.replace('bg-', '--'), variables);
      for (const surface of ['--surface-page', '--surface-card']) {
        const base = color(surface, variables);
        const alpha = Number(opacity) / 100;
        const painted = tint.map((channel, index) => channel * alpha + base[index]! * (1 - alpha));
        const [lower, upper] = [luminance(text), luminance(painted)].sort((a, b) => a - b);
        expect((upper! + 0.05) / (lower! + 0.05), `${theme} ${surface}`).toBeGreaterThanOrEqual(
          4.5
        );
      }
    }
  );
  it('escapes notice text supplied in the redirect URL', async () => {
    const text = '<script>alert(1)</script> Inventory action completed.';
    await show({ notice: text, kind: 'success' });
    const notice = screen.getByText(text);
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice.querySelector('script')).toBeNull();
  });
});

describe('Quarantine resolution forms', () => {
  it.each(['AVAILABLE', 'QUARANTINE', 'DAMAGED'])(
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

  it('never offers a damaged hold for release back to sale', async () => {
    lots.mockResolvedValue([{ ...lot, balances: [{ ...available, disposition: 'DAMAGED' }] }]);
    await show();
    expect(screen.queryByRole('button', { name: 'Release manual hold' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: 'Imported stock references' })).toHaveAttribute(
      'href',
      '/pharmacy/inventory/imports'
    );
    expect(screen.queryByText(/awaiting verification/i)).not.toBeInTheDocument();
  });

  it('shows available stock as boxes + strips with the tablet total (DEV-727)', async () => {
    lots.mockResolvedValue([
      {
        ...lot,
        packLevelId: 'box',
        unitsPerPack: 100,
        packLevel: {
          presentation: {
            dosageForm: 'Tablet',
            packLevels: [
              { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
              { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 10 },
              { id: 'tab', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 },
            ],
          },
        },
        balances: [{ ...available, onHandUnits: 570, sealedPacks: 5, looseUnits: 70 }],
      },
    ]);
    await show();
    expect(screen.getByText('5 boxes + 7 strips (570 tabs) · 5 sealed + 70 loose')).toBeVisible();
    expect(screen.queryByText(/570 units/)).not.toBeInTheDocument();
    expect(lots).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        include: expect.objectContaining({
          packLevel: {
            select: {
              presentation: {
                select: {
                  dosageForm: true,
                  packLevels: expect.objectContaining({ where: { organizationId: 'org' } }),
                },
              },
            },
          },
        }),
      })
    );
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

describe('Stock location creation access (issue #976)', () => {
  function locationForm() {
    return screen.getByRole('button', { name: 'Create location' }).closest('form')!;
  }

  function fillAndSubmit(form: HTMLFormElement) {
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Front store' } });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'FS-1' } });
    fireEvent.submit(form);
  }

  function redirectedNotice() {
    const destination = new URL(String(mocks.redirect.mock.calls[0]?.[0]), 'http://localhost');
    return {
      notice: destination.searchParams.get('notice'),
      kind: destination.searchParams.get('kind'),
    };
  }

  it('checks the same pharmacy:inventory capability the createLocation procedure enforces', async () => {
    await show();
    expect(mocks.can).toHaveBeenCalledWith(
      ctx.session.user,
      'pharmacy:inventory',
      undefined,
      expect.objectContaining({ db: ctx.db, source: 'TRPC', ip: '203.0.113.7' })
    );
    expect(screen.getByRole('button', { name: 'Create location' })).toBeVisible();
  });

  it('hides the Create location form for a user without inventory access', async () => {
    mocks.can.mockResolvedValue(false);
    await show();
    expect(screen.queryByRole('button', { name: 'Create location' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Creating stock locations needs inventory access — ask an owner.')
    ).toBeVisible();
    // Existing locations stay readable.
    expect(screen.getAllByText('Rack').length).toBeGreaterThan(0);
  });

  it('maps a FORBIDDEN rejection to the inventory-access message', async () => {
    const { TRPCError } = await import('@trpc/server');
    await show();
    const form = locationForm();
    // Access is revoked between render and submit.
    mocks.can.mockResolvedValue(false);
    mocks.createLocation.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission for this action.' })
    );
    fillAndSubmit(form);
    await waitFor(() => expect(mocks.redirect).toHaveBeenCalled());
    expect(redirectedNotice()).toEqual({
      notice: 'You don’t have inventory access — ask an owner.',
      kind: 'error',
    });
  });

  it('keeps a FORBIDDEN rejection generic when the user does hold inventory access', async () => {
    const { TRPCError } = await import('@trpc/server');
    await show();
    mocks.createLocation.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside this workspace.' })
    );
    fillAndSubmit(locationForm());
    await waitFor(() => expect(mocks.redirect).toHaveBeenCalled());
    expect(redirectedNotice()).toEqual({
      notice: 'The inventory action could not be completed. Review the fields and try again.',
      kind: 'error',
    });
  });

  it('keeps other failures generic and never leaks the server message', async () => {
    await show();
    mocks.createLocation.mockRejectedValue(new Error('unique constraint on code'));
    fillAndSubmit(locationForm());
    await waitFor(() => expect(mocks.redirect).toHaveBeenCalled());
    const { notice } = redirectedNotice();
    expect(notice).toBe(
      'The inventory action could not be completed. Review the fields and try again.'
    );
    expect(String(mocks.redirect.mock.calls[0]?.[0])).not.toContain('unique constraint');
  });

  it('keeps a FORBIDDEN recall refusal generic because recalls need pharmacy:safety', async () => {
    const { TRPCError } = await import('@trpc/server');
    ctx.db.pharmacyRecallNotice.findMany.mockResolvedValue([
      {
        id: 'recall-1',
        reference: 'RC-1',
        reason: 'Contamination',
        status: 'OPEN',
        acknowledgements: [],
      },
    ]);
    mocks.can.mockResolvedValue(false);
    mocks.acknowledgeRecall.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await show();
    fireEvent.submit(screen.getByRole('button', { name: 'Acknowledge branch' }).closest('form')!);
    await waitFor(() => expect(mocks.redirect).toHaveBeenCalled());
    expect(mocks.acknowledgeRecall).toHaveBeenCalledExactlyOnceWith({
      branchId: branch.id,
      recallNoticeId: 'recall-1',
    });
    expect(redirectedNotice()).toEqual({
      notice: 'The inventory action could not be completed. Review the fields and try again.',
      kind: 'error',
    });
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

describe('expiry advice in context (DEV-594)', () => {
  function asOwner() {
    (ctx.session.user as { role?: string }).role = 'ADMIN';
  }

  it('links an owner from near-expiry stock to the expiry advisor for this branch', async () => {
    asOwner();
    await show();
    expect(screen.getByRole('link', { name: 'Expiry advice' })).toHaveAttribute(
      'href',
      `/pharmacy/reports?branch=${branch.id}#expiry-advisor`
    );
    expect(mocks.can).toHaveBeenCalledWith(
      ctx.session.user,
      'reports:financial',
      undefined,
      expect.objectContaining({ db: ctx.db })
    );
  });

  it('offers no advisor link to a member the advisor would refuse', async () => {
    await show();
    expect(screen.queryByRole('link', { name: 'Expiry advice' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Act on expiring stock' })).toBeVisible();
  });

  it('offers no advisor link without financial report access', async () => {
    asOwner();
    mocks.can.mockImplementation(
      async (_user: unknown, action: string) => action !== 'reports:financial'
    );
    await show();
    expect(screen.queryByRole('link', { name: 'Expiry advice' })).not.toBeInTheDocument();
  });

  it('offers no advisor link when Pharmacy Reports is not in the package', async () => {
    asOwner();
    mocks.module.mockImplementation(
      (_entitlements: unknown, key: string) => key !== 'pharmacy-reports'
    );
    await show();
    expect(screen.queryByRole('link', { name: 'Expiry advice' })).not.toBeInTheDocument();
  });
});
