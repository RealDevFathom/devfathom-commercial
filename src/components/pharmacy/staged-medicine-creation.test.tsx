import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn(), run: vi.fn() }));
vi.mock('./staged-medicine-creation-actions', () => ({
  requestStagedMedicineCreation: mocks.request,
  runStagedMedicineCreationStep: mocks.run,
}));

import { StagedMedicineCreation, type StagedCreationState } from './staged-medicine-creation';

const base: StagedCreationState = {
  request: null,
  canRequest: true,
  candidates: 500,
  done: 0,
  remaining: 500,
  unnamed: 2,
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
    expect(mocks.request).toHaveBeenCalledWith('batch_1');
    expect(screen.getByText(/owner approves it with their own PIN/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
  });

  it('does not offer the request to a reviewer who cannot edit the catalogue', () => {
    render(<StagedMedicineCreation batchId="batch_1" initial={{ ...base, canRequest: false }} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('creates an approved file step by step until nothing remains', async () => {
    mocks.run
      .mockResolvedValueOnce({ data: { created: 250, done: 250, remaining: 250 } })
      .mockResolvedValueOnce({ data: { created: 250, done: 500, remaining: 0 } });
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
});
