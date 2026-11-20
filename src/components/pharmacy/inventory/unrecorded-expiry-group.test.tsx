import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnrecordedExpiryGroup, type UnrecordedExpiryRow } from './unrecorded-expiry-group';

afterEach(cleanup);

const neither: UnrecordedExpiryRow = {
  key: 'lot_1:location_1',
  inventoryLotId: 'lot_1',
  stockLocationId: 'location_1',
  locationName: 'Main shelf',
  medicineName: 'Legacy Panadol',
  batchNumber: null,
  printedExpiry: null,
  onHandUnits: 40,
  unitsPerPack: 10,
};
const batchOnly: UnrecordedExpiryRow = {
  ...neither,
  key: 'lot_2:location_1',
  inventoryLotId: 'lot_2',
  medicineName: 'Legacy Brufen',
  batchNumber: 'B-9',
};
const expiryOnly: UnrecordedExpiryRow = {
  ...neither,
  key: 'lot_3:location_1',
  inventoryLotId: 'lot_3',
  medicineName: 'Legacy Augmentin',
  printedExpiry: '2027-06-10',
};

function renderGroup(rows: UnrecordedExpiryRow[], withinDays = 90) {
  render(
    <UnrecordedExpiryGroup action={vi.fn()} branchId="branch" rows={rows} withinDays={withinDays} />
  );
}

describe('DEV-853 expiry board — unrecorded batch or expiry group', () => {
  it('lists the lots in their own group, saying what is missing in plain words', () => {
    renderGroup([neither, batchOnly, expiryOnly]);
    expect(screen.getByRole('heading', { name: 'Batch or expiry not recorded' })).toBeVisible();
    const table = screen.getByRole('table', { name: 'Lots with no recorded batch or expiry' });
    expect(within(table).getByText(/Batch not recorded · Expiry not recorded/)).toBeVisible();
    expect(within(table).getByText(/Batch B-9 · Expiry not recorded/)).toBeVisible();
    expect(within(table).getByText(/Batch not recorded · Exp 2027-06-10/)).toBeVisible();
    expect(screen.getByText('3 lots')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/MISSING_|null/);
  });

  it('asks only for what is missing, and accepts a printed day or month', () => {
    renderGroup([neither, batchOnly, expiryOnly], 60);
    const both = screen.getByRole('form', { name: 'Record batch and expiry for Legacy Panadol' });
    expect(within(both).getByLabelText('Batch number')).toBeVisible();
    const expiry = within(both).getByLabelText('Expiry as printed');
    expect(expiry).toHaveAttribute('placeholder', 'YYYY-MM or YYYY-MM-DD');
    expect(expiry).toHaveAttribute('pattern', '\\d{4}-\\d{2}(-\\d{2})?');
    expect(within(both).getByRole('button', { name: 'Record' })).toBeEnabled();
    const hidden = Object.fromEntries(
      [...both.querySelectorAll('input[type="hidden"]')].map((input) => [
        input.getAttribute('name'),
        input.getAttribute('value'),
      ])
    );
    expect(hidden).toEqual({
      action: 'record',
      branchId: 'branch',
      within: '60',
      inventoryLotId: 'lot_1',
    });

    const needsExpiry = screen.getByRole('form', {
      name: 'Record batch and expiry for Legacy Brufen',
    });
    expect(within(needsExpiry).queryByLabelText('Batch number')).toBeNull();
    expect(within(needsExpiry).getByLabelText('Expiry as printed')).toBeVisible();

    // A lot with a known expiry but no batch number can still get its batch.
    const needsBatch = screen.getByRole('form', {
      name: 'Record batch and expiry for Legacy Augmentin',
    });
    expect(within(needsBatch).getByLabelText('Batch number')).toBeVisible();
    expect(within(needsBatch).queryByLabelText('Expiry as printed')).toBeNull();
  });

  it('says so when every lot has a recorded batch and expiry', () => {
    renderGroup([]);
    expect(
      screen.getByText('Every lot on hand has a recorded batch number and expiry.')
    ).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('0 lots')).toBeVisible();
  });
});
