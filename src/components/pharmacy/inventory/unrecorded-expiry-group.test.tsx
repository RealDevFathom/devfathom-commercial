import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnrecordedExpiryGroup, type UnrecordedExpiryRow } from './unrecorded-expiry-group';

afterEach(cleanup);

const row: UnrecordedExpiryRow = {
  key: 'lot_1:location_1',
  inventoryLotId: 'lot_1',
  stockLocationId: 'location_1',
  locationName: 'Main shelf',
  medicineName: 'Legacy Panadol',
  batchNumber: null,
  onHandUnits: 40,
  unitsPerPack: 10,
};

describe('DEV-853 expiry board — "Expiry not recorded" group', () => {
  it('lists unrecorded-expiry lots in their own group, in plain words', () => {
    render(
      <UnrecordedExpiryGroup
        action={vi.fn()}
        branchId="branch"
        rows={[
          row,
          { ...row, key: 'lot_2:location_1', inventoryLotId: 'lot_2', batchNumber: 'B-9' },
        ]}
        withinDays={90}
      />
    );
    expect(screen.getByRole('heading', { name: 'Expiry not recorded' })).toBeVisible();
    const table = screen.getByRole('table', { name: 'Lots with no recorded expiry' });
    expect(within(table).getByText(/Batch not recorded · Expiry not recorded/)).toBeVisible();
    expect(within(table).getByText(/Batch B-9 · Expiry not recorded/)).toBeVisible();
    expect(screen.getByText('2 lots')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/MISSING_|null/);
  });

  it('offers a form to record the batch (when missing) and the expiry from the pack', () => {
    render(
      <UnrecordedExpiryGroup
        action={vi.fn()}
        branchId="branch"
        rows={[
          row,
          {
            ...row,
            key: 'lot_2:location_1',
            inventoryLotId: 'lot_2',
            medicineName: 'Legacy Brufen',
            batchNumber: 'B-9',
          },
        ]}
        withinDays={60}
      />
    );
    const missingBoth = screen.getByRole('form', {
      name: 'Record batch and expiry for Legacy Panadol',
    });
    expect(within(missingBoth).getByLabelText('Batch number')).toBeVisible();
    expect(within(missingBoth).getByLabelText('Expiry month')).toHaveAttribute('type', 'month');
    expect(within(missingBoth).getByRole('button', { name: 'Record' })).toBeEnabled();
    const hidden = Object.fromEntries(
      [...missingBoth.querySelectorAll('input[type="hidden"]')].map((input) => [
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
    const batchKnown = screen.getByRole('form', {
      name: 'Record batch and expiry for Legacy Brufen',
    });
    expect(within(batchKnown).queryByLabelText('Batch number')).toBeNull();
    expect(within(batchKnown).getByLabelText('Expiry month')).toBeVisible();
  });

  it('says so when every lot has a recorded expiry', () => {
    render(<UnrecordedExpiryGroup action={vi.fn()} branchId="branch" rows={[]} withinDays={90} />);
    expect(screen.getByText('Every lot on hand has a recorded expiry.')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('0 lots')).toBeVisible();
  });
});
