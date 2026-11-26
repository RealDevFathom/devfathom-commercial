import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AbuzarImportForm } from './abuzar-import-form';
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyOwnerImport: {
      options: {
        useQuery: () => ({
          data: { branches: [{ id: 'b', name: 'Synthetic pharmacy' }], locations: [] },
        }),
      },
    },
  },
}));
it('lets the owner select a prepared export and requires a preview before posting', () => {
  render(<AbuzarImportForm />);
  expect(screen.getByLabelText('Prepared export files')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview step' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Confirm totals and apply' })).toBeNull();
});
