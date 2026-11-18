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

describe('DEV-933: one opening-count rule on a slow or fast access check', () => {
  const form = () => screen.getByRole('form', { name: 'Open the cash drawer to start the shift' });

  it.each([false, true])(
    'waits for the access check, then needs a typed count (manager: %s)',
    (canDeclareFloat) => {
      const onOpen = vi.fn();
      const view = render(
        <CounterOpenDrawerStep
          disabled={false}
          accessChecking
          canDeclareFloat={canDeclareFloat}
          onOpen={onOpen}
        />
      );
      expect(screen.getByLabelText('Opening cash')).toBeDisabled();
      expect(screen.getByLabelText('Opening cash')).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Open drawer' })).toBeDisabled();
      expect(screen.getByText('Checking your access…')).toBeInTheDocument();
      fireEvent.submit(form());
      expect(onOpen).not.toHaveBeenCalled();

      view.rerender(
        <CounterOpenDrawerStep disabled={false} canDeclareFloat={canDeclareFloat} onOpen={onOpen} />
      );
      expect(screen.getByLabelText('Opening cash')).toBeEnabled();
      expect(screen.getByLabelText('Opening cash')).toHaveValue('');
      fireEvent.submit(form());
      expect(onOpen).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Enter the opening cash');
      fireEvent.change(screen.getByLabelText('Opening cash'), { target: { value: '0' } });
      fireEvent.submit(form());
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(0, undefined);
    }
  );

  it('shows the same empty field when the check answers before first paint', () => {
    render(<CounterOpenDrawerStep disabled={false} onOpen={vi.fn()} />);
    expect(screen.getByLabelText('Opening cash')).toHaveValue('');
  });
});
