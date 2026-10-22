// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportMappingWorkflow } from './import-mapping-workflow';
const columns = [
  { name: 'Dawai', samples: ['Panadol'] },
  { name: 'T.P.', samples: ['120.00'] },
];
describe('ImportMappingWorkflow', () => {
  it('auto-maps columns, exposes samples and saves a valid preset', () => {
    const save = vi.fn();
    render(<ImportMappingWorkflow columns={columns} onSavePreset={save} />);
    expect(screen.getByLabelText('Target for Dawai')).toHaveValue('product_name');
    expect(screen.getByText('Panadol')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'Abuzar stock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping preset' }));
    expect(save).toHaveBeenCalledWith(
      'Abuzar stock',
      expect.objectContaining({ Dawai: 'product_name' })
    );
  });
  it('renders preview counts, background action and rollback confirmation', () => {
    render(
      <ImportMappingWorkflow
        columns={columns}
        preview={{ errors: 0, dedupeMatches: 2, entities: [{ key: 'med.product', count: 4 }] }}
      />
    );
    expect(screen.getByText('med.product:')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /roll back import/i }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Existing pharmacy data is never removed'
    );
  });
});
