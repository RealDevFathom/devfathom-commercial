import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubstitutionForm } from './substitution-form';

describe('SubstitutionForm', () => {
  it('has no silent submission path and requires patient acknowledgement', () => {
    const submit = vi.fn();
    render(
      <SubstitutionForm
        prescribed={{ id: 'original', label: 'Tablet 10mg' }}
        choices={[{ id: 'replacement', label: 'Tablet 10mg · alternate brand' }]}
        onSubmit={submit}
      />
    );
    const button = screen.getByRole('button', { name: 'Record substitution' });
    expect(button).toBeDisabled();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Supplied presentation', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'replacement' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Equivalence basis', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Same active ingredient and strength' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Governing rule reference', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Rule 12' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Patient communication', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Alternate brand explained' },
    });
    fireEvent.click(screen.getByLabelText('Patient communication was acknowledged', { selector: ':not([data-select-field-native][aria-hidden="true"])' }));
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        suppliedPresentationId: 'replacement',
        patientCommunication: 'Alternate brand explained',
      })
    );
  });
});
