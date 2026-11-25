import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ context: vi.fn(), can: vi.fn(), staged: vi.fn() }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/lib/abac', () => ({
  can: mocks.can,
  subjectFromSession: (user: { id: string; role: string }) => user,
}));
vi.mock('@/components/pharmacy/staged-medicine-catalogue', () => ({
  StagedMedicineCatalogue: mocks.staged,
}));
vi.mock('@/components/pharmacy/medicine-reference-workbench', () => ({
  MedicineReferenceWorkbench: () => <div>Existing workbench</div>,
}));
vi.mock('@/components/pharmacy/add-medicine-form', () => ({
  AddMedicineForm: () => <div>Add medicine form</div>,
}));
vi.mock('@/components/pharmacy/catalogue-approval-queue', () => ({
  CatalogueApprovalQueue: () => <div>Catalogue approval queue</div>,
}));
vi.mock('@/lib/pharmacy/licensed-reference-connectors', () => ({
  medicineConnectorHealth: () => [],
}));

import MedicinePage from './page';

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.staged.mockResolvedValue(<div>Staged catalogue</div>);
});

function member(role: string) {
  mocks.context.mockResolvedValue({
    db: {},
    requestMeta: { ip: null },
    session: { user: { id: 'user_a', role } },
  });
}

describe('DEV-19 medicine page access', () => {
  it('lets a pharmacist reviewer who is not an administrator reach only the approval queue', async () => {
    member('EMPLOYEE');
    mocks.can.mockResolvedValue(true);
    render(await MedicinePage({}));
    expect(screen.getByRole('heading', { name: 'Catalogue review', level: 1 })).toBeVisible();
    expect(screen.getByText('Catalogue approval queue')).toBeVisible();
    expect(screen.queryByText('Existing workbench')).toBeNull();
    expect(screen.queryByText('Add medicine form')).toBeNull();
    expect(mocks.staged).not.toHaveBeenCalled();
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_a' }),
      'pharmacy:catalogue-review',
      undefined,
      expect.objectContaining({ db: {} })
    );
  });

  it('refuses a member without catalogue review or administration', async () => {
    member('EMPLOYEE');
    mocks.can.mockResolvedValue(false);
    render(await MedicinePage({}));
    expect(
      screen.getByRole('heading', { name: 'Catalog administration permission required' })
    ).toBeVisible();
    expect(
      screen.getByText(/Ask a pharmacist with catalogue review permission to review this import/)
    ).toBeVisible();
    expect(screen.queryByText('Catalogue approval queue')).toBeNull();
    expect(mocks.staged).not.toHaveBeenCalled();
  });

  it('keeps the full catalogue for an administrator', async () => {
    member('ADMIN');
    render(await MedicinePage({}));
    expect(screen.getByText('Staged catalogue')).toBeVisible();
    expect(screen.getByText('Catalogue approval queue')).toBeVisible();
    expect(screen.getByText('Existing workbench')).toBeInTheDocument();
    expect(screen.getByText('Add medicine form')).toBeVisible();
    expect(mocks.can).not.toHaveBeenCalled();
  });
});
