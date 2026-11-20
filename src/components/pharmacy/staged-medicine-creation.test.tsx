import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn(), run: vi.fn(), notCreated: vi.fn() }));
vi.mock('./staged-medicine-creation-actions', () => ({
  requestStagedMedicineCreation: mocks.request,
  runStagedMedicineCreationStep: mocks.run,
  readNotCreatedStagedRows: mocks.notCreated,
}));

import { StagedMedicineCreation, type StagedCreationState } from './staged-medicine-creation';

const base: StagedCreationState = {
  request: null,
  canRequest: true,
  candidates: 500,
  done: 0,
  notCreated: 0,
  remaining: 500,
  unnamed: 2,
  matchedEarlier: 0,
  barcodesNotAttached: 0,
  suppliersNotMatched: 0,
  reorderLevelsNotApplied: 0,
  aliasesNotAdded: 0,
};

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe('DEV-912 staged medicine creation panel', () => {
  it('asks once for the whole file and then waits for a different reviewer', async () => {
    mocks.request.mockResolvedValue({
      data: { ...base, request: { id: 'edit_1', status: 'PENDING' } },
    });
    render(<StagedMedicineCreation batchId="batch_1" initial={base} />);
    expect(screen.getByText(/2 rows have no name and are skipped/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Ask to create 500 medicines' }));
    expect(await screen.findByText('Waiting for approval')).toBeVisible();
    expect(mocks.request).toHaveBeenCalledWith('batch_1', undefined);
    expect(screen.getByText(/owner approves it with their own PIN/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
  });

  it('names the chosen branch for the reorder levels in the request', async () => {
    mocks.request.mockResolvedValue({
      data: { ...base, request: { id: 'edit_1', status: 'PENDING' } },
    });
    render(<StagedMedicineCreation batchId="batch_1" branchId="branch_1" initial={base} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask to create 500 medicines' }));
    expect(await screen.findByText('Waiting for approval')).toBeVisible();
    expect(mocks.request).toHaveBeenCalledWith('batch_1', 'branch_1');
  });

  it('reports suppliers not linked and reorder levels not set', () => {
    render(
      <StagedMedicineCreation
        batchId="batch_1"
        initial={{ ...base, suppliersNotMatched: 4, reorderLevelsNotApplied: 2 }}
      />
    );
    expect(
      screen.getByText(/4 rows name a supplier that is not one of your suppliers/)
    ).toBeVisible();
    expect(screen.getByText(/2 reorder levels were not set/)).toBeVisible();
  });

  it('does not offer the request to a reviewer who cannot edit the catalogue', () => {
    render(<StagedMedicineCreation batchId="batch_1" initial={{ ...base, canRequest: false }} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('creates an approved file step by step until nothing remains', async () => {
    mocks.run
      .mockResolvedValueOnce({
        data: {
          created: 250,
          matched: 0,
          done: 250,
          remaining: 250,
          matchedEarlier: 0,
          barcodesNotAttached: 0,
          suppliersNotMatched: 0,
          reorderLevelsNotApplied: 0,
        },
      })
      .mockResolvedValueOnce({
        data: {
          created: 240,
          matched: 10,
          done: 500,
          remaining: 0,
          matchedEarlier: 10,
          barcodesNotAttached: 3,
          suppliersNotMatched: 0,
          reorderLevelsNotApplied: 0,
        },
      });
    render(
      <StagedMedicineCreation
        batchId="batch_1"
        initial={{ ...base, request: { id: 'edit_1', status: 'APPROVED' } }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create medicines' }));
    expect(await screen.findByText('All medicines created')).toBeVisible();
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/500 created · 0 still to create/)).toBeVisible();
    expect(
      screen.getByText(/10 rows name a medicine an earlier file already created/)
    ).toBeVisible();
    expect(screen.getByText(/3 barcodes were not added/)).toBeVisible();
  });

  it('stops on a refusal and says why, keeping what was created', async () => {
    mocks.run.mockResolvedValue({
      error: 'Creating these medicines needs an approved request first.',
    });
    render(
      <StagedMedicineCreation
        batchId="batch_1"
        initial={{ ...base, request: { id: 'edit_1', status: 'APPROVED' } }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create medicines' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs an approved request');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create medicines' })).toBeEnabled()
    );
  });
  it('DEV-1002: carries on past refused rows, lists them and names the next step', async () => {
    const step = {
      matched: 0,
      matchedEarlier: 0,
      barcodesNotAttached: 0,
      suppliersNotMatched: 0,
      reorderLevelsNotApplied: 0,
    };
    mocks.run
      // A step whose every row was refused still moves on to the rest of the file.
      .mockResolvedValueOnce({
        data: { ...step, created: 0, refused: 2, done: 0, notCreated: 2, remaining: 498 },
      })
      .mockResolvedValueOnce({
        data: { ...step, created: 497, refused: 1, done: 497, notCreated: 3, remaining: 0 },
      });
    render(
      <StagedMedicineCreation
        batchId="batch_1"
        initial={{ ...base, request: { id: 'edit_1', status: 'APPROVED' } }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create medicines' }));
    expect(await screen.findByText('Finished: 3 rows not created')).toBeVisible();
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(/497 created · 3 could not be created · 0 still to create/)
    ).toBeVisible();
    expect(screen.getByText(/3 rows could not be created/)).toHaveTextContent(
      'Correct those rows in the file and upload it again'
    );
    expect(screen.queryByText('All medicines created')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create medicines' })).toBeNull();
  });

  it('DEV-1002: shows the plain stop message, never "Nothing was changed"', async () => {
    const { STAGED_CREATION_STOPPED } = await import('@/lib/pharmacy/migration/staged-creation');
    mocks.run.mockResolvedValue({ error: STAGED_CREATION_STOPPED });
    render(
      <StagedMedicineCreation
        batchId="batch_1"
        initial={{
          ...base,
          request: { id: 'edit_1', status: 'APPROVED' },
          done: 18_000,
          remaining: 933,
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create medicines' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Medicines already created are kept');
    expect(alert).not.toHaveTextContent('Nothing was changed');
    expect(screen.getByText(/18,000 created · 933 still to create/)).toBeVisible();
  });

  it('DEV-1002: lists the rows that could not be created, with their reasons', async () => {
    const reason =
      'A value in this row is not accepted by the catalogue. Correct the row in the file and upload the file again: medicines already created are matched, never made twice.';
    const listed = (total: number, numbers: number[]) => ({
      total,
      rows: numbers.map((rowNumber) => ({
        rowId: `row_${rowNumber}`,
        rowNumber,
        productName: `Fixture ${rowNumber}`,
        reason,
      })),
    });
    mocks.run.mockResolvedValueOnce({
      data: {
        created: 498,
        matched: 0,
        refused: 2,
        done: 498,
        notCreated: 2,
        remaining: 0,
        matchedEarlier: 0,
        barcodesNotAttached: 0,
        suppliersNotMatched: 0,
        reorderLevelsNotApplied: 0,
        aliasesNotAdded: 1,
      },
    });
    mocks.notCreated.mockResolvedValueOnce({ data: listed(12, [18_005, 18_007]) });
    render(
      <StagedMedicineCreation
        batchId="batch_1"
        branchId="branch_1"
        initial={{ ...base, request: { id: 'edit_1', status: 'APPROVED' } }}
        review={{
          sourceId: 'source_1',
          path: '/pharmacy/medicines?branchId=branch_1&sourceId=source_1&batchId=batch_1&page=3',
          notCreated: { total: 0, rows: [] },
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create medicines' }));
    const list = await screen.findByRole('list', { name: 'Rows that could not be created' });
    expect(mocks.notCreated).toHaveBeenCalledWith({
      branchId: 'branch_1',
      sourceId: 'source_1',
      batchId: 'batch_1',
    });
    expect(list).toHaveTextContent('Row 18,005: Fixture 18005');
    expect(list).toHaveTextContent('not accepted by the catalogue');
    expect(screen.getByRole('link', { name: 'Row 18,007: Fixture 18007' })).toHaveAttribute(
      'href',
      '/pharmacy/medicines?branchId=branch_1&sourceId=source_1&batchId=batch_1&rowId=row_18007'
    );
    expect(
      screen.getByRole('link', { name: 'Show all 12 rows that could not be created' })
    ).toHaveAttribute(
      'href',
      '/pharmacy/medicines?branchId=branch_1&sourceId=source_1&batchId=batch_1&filter=not-created'
    );
    expect(
      screen.getByText(/1 rows have an old code or generic name that was not added/)
    ).toBeVisible();
  });

  it('DEV-1002: stops and does not continue when many rows were refused for one reason', async () => {
    const message =
      'Creating stopped: many rows were refused for the same reason: a value is not accepted by the catalogue. Nothing was recorded for these rows, and medicines already created are kept. Tell your administrator.';
    mocks.run.mockResolvedValue({ error: message });
    render(
      <StagedMedicineCreation
        batchId="batch_1"
        initial={{ ...base, request: { id: 'edit_1', status: 'APPROVED' } }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create medicines' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('list', { name: 'Rows that could not be created' })).toBeNull();
  });
});
