import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OperatorSwitch } from './operator-switch';

describe('OperatorSwitch', () => {
  it('validates with terminal-state rules and submits the incoming identity', async () => {
    const onSwitch = vi.fn().mockResolvedValue(true);
    render(
      <OperatorSwitch
        activeOperatorId="staff-1"
        operators={[
          { staffProfileId: 'staff-1', displayName: 'Amina Khan', role: 'Supervisor' },
          { staffProfileId: 'staff-2', displayName: 'Bilal Shah', role: 'Cashier' },
        ]}
        pending={false}
        onSwitch={onSwitch}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch operator' }));
    expect(screen.getByText('Currently acting: Amina Khan — Supervisor')).toBeVisible();
    expect(screen.queryByText('staff-1')).not.toBeInTheDocument();
    fireEvent.change(selectFieldControl(screen.getByLabelText('Operator', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'staff-2' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Operator PIN', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '12ab34' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }));
    await waitFor(() =>
      expect(onSwitch).toHaveBeenCalledWith({
        staffProfileId: 'staff-2',
        type: 'PIN',
        secret: '1234',
      })
    );
    expect(screen.getByRole('button', { name: 'Switch operator' })).toBeEnabled();
  });
});
