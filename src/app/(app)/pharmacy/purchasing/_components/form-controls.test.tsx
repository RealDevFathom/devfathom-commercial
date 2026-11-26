import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';

import { SelectField } from './form-controls';

it('submits the visible Studio supplier choice once, while keeping ineligible suppliers disabled', async () => {
  render(
    <form aria-label="Purchase order">
      <SelectField
        label="Supplier"
        name="supplierId"
        notice={null}
        emptyHint="No suppliers."
        options={[
          { value: 'approved', label: 'Approved supplier' },
          { value: 'lapsed', label: 'Lapsed supplier — not authorized', disabled: true },
        ]}
        required
      />
    </form>
  );
  const form = screen.getByRole<HTMLFormElement>('form', { name: 'Purchase order' });
  const supplier = screen.getByRole('combobox', { name: 'Supplier' });
  expect(supplier).toHaveAttribute('data-select-field-trigger');
  expect(supplier).toHaveAttribute('aria-required', 'true');
  act(() => expect(form.checkValidity()).toBe(false));

  supplier.focus();
  fireEvent.keyDown(supplier, { key: 'ArrowDown' });
  expect(
    await screen.findByRole('option', { name: 'Lapsed supplier — not authorized' })
  ).toHaveAttribute('aria-disabled', 'true');
  const approved = screen.getByRole('option', { name: 'Approved supplier' });
  fireEvent.pointerDown(approved, { pointerType: 'mouse' });
  fireEvent.click(approved, { detail: 1 });
  await waitFor(() => expect(supplier).toHaveTextContent('Approved supplier'));
  expect(form.checkValidity()).toBe(true);
  expect(new FormData(form).getAll('supplierId')).toEqual(['approved']);
});
