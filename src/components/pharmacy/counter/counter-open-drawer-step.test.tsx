import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CounterOpenDrawerStep } from './counter-open-drawer-step';

describe('counter opening focus', () => {
  it('focuses opening cash when the initial access check enables the field', () => {
    const onOpen = vi.fn();
    const view = render(<CounterOpenDrawerStep disabled onOpen={onOpen} />);
    expect(screen.getByLabelText('Opening cash')).toBeDisabled();
    expect(screen.getByLabelText('Opening cash')).not.toHaveFocus();
    view.rerender(<CounterOpenDrawerStep disabled={false} onOpen={onOpen} />);
    expect(screen.getByLabelText('Opening cash')).toHaveFocus();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('keeps focus on a control chosen while the access check was pending', () => {
    const onOpen = vi.fn();
    const view = render(
      <>
        <button>Help</button>
        <CounterOpenDrawerStep disabled onOpen={onOpen} />
      </>
    );
    screen.getByRole('button', { name: 'Help' }).focus();
    view.rerender(
      <>
        <button>Help</button>
        <CounterOpenDrawerStep disabled={false} onOpen={onOpen} />
      </>
    );
    expect(screen.getByRole('button', { name: 'Help' })).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Open the cash drawer to start the shift' }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(0, undefined);
  });
});
