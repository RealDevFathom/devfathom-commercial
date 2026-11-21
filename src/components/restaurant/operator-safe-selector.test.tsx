import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OperatorSafeSelector } from './operator-safe-selector';

describe('OperatorSafeSelector', () => {
  it('filters by human label and readable code but submits the listed internal value', () => {
    const onChange = vi.fn();
    render(
      <OperatorSafeSelector
        label="Order"
        value=""
        onChange={onChange}
        options={[
          { value: 'db-internal-1', label: 'Order 1042', code: 'Downtown · Aug 30' },
          { value: 'db-internal-2', label: 'Order 1043', code: 'Airport · Aug 30' },
        ]}
      />
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '1042' } });
    expect(screen.queryByRole('option', { hidden: true, name: /1043/ })).not.toBeInTheDocument();
    fireEvent.change(selectFieldControl(screen.getByRole('combobox')), {
      target: { value: 'db-internal-1' },
    });
    expect(onChange).toHaveBeenCalledWith('db-internal-1');
  });

  it('disables forbidden choices and reports a stale selection', () => {
    const { rerender } = render(
      <OperatorSafeSelector label="Gateway" value="" onChange={vi.fn()} options={[]} forbidden />
    );
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('option', { hidden: true })).toHaveTextContent(
      'Gateway unavailable for your access'
    );
    rerender(
      <OperatorSafeSelector
        label="Gateway"
        value="removed"
        onChange={vi.fn()}
        options={[{ value: 'current', label: 'Current' }]}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('no longer available');
  });
});
