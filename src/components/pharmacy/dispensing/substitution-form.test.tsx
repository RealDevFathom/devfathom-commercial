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
    fireEvent.change(screen.getByLabelText('Strength / form given instead'), {
      target: { value: 'replacement' },
    });
    fireEvent.change(screen.getByLabelText('Why it is equivalent'), {
      target: { value: 'Same active ingredient and strength' },
    });
    fireEvent.change(screen.getByLabelText('Rule or approval reference'), {
      target: { value: 'Rule 12' },
    });
    fireEvent.change(screen.getByLabelText('What you told the patient'), {
      target: { value: 'Alternate brand explained' },
    });
    fireEvent.click(screen.getByLabelText('The patient confirmed they understood'));
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        suppliedPresentationId: 'replacement',
        patientCommunication: 'Alternate brand explained',
      })
    );
  });
});
