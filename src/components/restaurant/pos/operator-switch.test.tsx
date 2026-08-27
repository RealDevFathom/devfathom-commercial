import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OperatorSwitch } from './operator-switch';

describe('OperatorSwitch', () => {
  it('validates with terminal-state rules and submits the incoming identity', async () => {
    const onSwitch = vi.fn().mockResolvedValue(true);
    render(<OperatorSwitch activeOperatorId="staff-1" pending={false} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch operator' }));
    fireEvent.change(screen.getByLabelText('Operator profile ID'), {
      target: { value: 'staff-2' },
    });
    fireEvent.change(screen.getByLabelText('Operator PIN'), { target: { value: '12ab34' } });
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
