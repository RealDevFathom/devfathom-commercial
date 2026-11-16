import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  stage: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock('./migration-staging-actions', () => ({
  readStagingUpload: mocks.read,
  stageMigrationBatch: mocks.stage,
}));
import { MigrationStagingForm } from './migration-staging-form';
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({
    data: {
      headers: ['Product', 'Pack', 'Qty'],
      rowCount: 1,
      mapping: { product: 0, pack: 1, quantity: 2 },
    },
  });
  mocks.stage.mockResolvedValue({
    data: { sourceId: 'source_a', batchId: 'batch_a', rowCount: 1, exceptionCount: 0 },
  });
});
async function upload() {
  const file = new File(['Product,Pack,Qty\nExample,30,29'], 'legacy.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode('Product,Pack,Qty\nExample,30,29').buffer,
  });
  fireEvent.change(screen.getByLabelText('Source file'), { target: { files: [file] } });
  await screen.findByLabelText('Quantity column counts');
}
describe('staging column mapping', () => {
  it.each(['PACKS', 'UNITS'])(
    'requires an explicit %s choice and carries it to staging',
    async (unit) => {
      render(<MigrationStagingForm branchId="branch_a" route="/pharmacy/medicines/staged" />);
      await upload();
      expect(screen.getByLabelText('Quantity column counts')).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Stage for review' })).toBeDisabled();
      expect(mocks.stage).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText('Quantity column counts'), {
        target: { value: unit },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
      await waitFor(() =>
        expect(mocks.stage).toHaveBeenCalledWith(
          expect.objectContaining({
            branchId: 'branch_a',
            quantityUnit: unit,
            mapping: { product: 0, pack: 1, quantity: 2 },
          })
        )
      );
      await waitFor(() =>
        expect(mocks.push).toHaveBeenCalledWith(
          '/pharmacy/medicines/staged?branchId=branch_a&sourceId=source_a&batchId=batch_a'
        )
      );
    }
  );
  it('resets the quantity choice for a new file', async () => {
    render(<MigrationStagingForm branchId="branch_a" route="/pharmacy/medicines/staged" />);
    await upload();
    fireEvent.change(screen.getByLabelText('Quantity column counts'), {
      target: { value: 'PACKS' },
    });
    await upload();
    expect(screen.getByLabelText('Quantity column counts')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Stage for review' })).toBeDisabled();
  });
  it('preserves the mapping and choice after a server refusal', async () => {
    mocks.stage.mockResolvedValue({ error: 'Map each field to a distinct column in this file.' });
    render(<MigrationStagingForm branchId="branch_a" route="/pharmacy/medicines/staged" />);
    await upload();
    fireEvent.change(screen.getByLabelText('Quantity column counts'), {
      target: { value: 'PACKS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stage for review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('distinct column');
    expect(screen.getByLabelText('Quantity column counts')).toHaveValue('PACKS');
    expect(screen.getByLabelText('Quantity')).toHaveValue('2');
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
