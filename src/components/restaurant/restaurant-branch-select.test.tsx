import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { selectFieldControl } from '@/lib/testing/select-field';

import { RestaurantBranchSelect } from './restaurant-branch-select';

describe('RestaurantBranchSelect', () => {
  it('shows readable names and stable codes while keeping opaque ids out of labels', () => {
    render(
      <RestaurantBranchSelect
        branches={[
          {
            id: 'cmtxopaque123',
            name: 'DHA Phase 6',
            code: 'DHA-PH6',
            active: true,
            isDefault: true,
          },
        ]}
      />
    );
    const option = within(selectFieldControl(screen.getByRole('combobox'))).getByRole('option', {
      name: 'DHA Phase 6 · DHA-PH6 (default)',
      hidden: true,
    });
    expect(option).toHaveValue('cmtxopaque123');
    expect(option).not.toHaveTextContent('cmtxopaque123');
  });

  const branches = [
    { id: 'main', name: 'Main', code: 'MAIN', active: true, isDefault: true },
    { id: 'second', name: 'Second', code: 'SECOND', active: true, isDefault: false },
    { id: 'closed', name: 'Closed', active: false, isDefault: false },
  ];

  it('keeps the branch name and form value while keyboard navigation changes the selection', async () => {
    const changed = vi.fn();
    function Example() {
      const [value, setValue] = useState('main');
      return (
        <form aria-label="Restaurant branch">
          <RestaurantBranchSelect
            name="branchId"
            ariaLabel="Working branch"
            branches={branches}
            value={value}
            required
            onChange={(next) => {
              changed(next);
              setValue(next);
            }}
          />
        </form>
      );
    }
    render(<Example />);
    const form = screen.getByRole('form') as HTMLFormElement;
    const trigger = screen.getByRole('combobox', { name: 'Working branch' });
    expect(trigger).toHaveTextContent('Main · MAIN (default)');
    expect(trigger).toHaveAttribute('aria-required', 'true');
    expect(trigger).toHaveClass('min-h-11', 'min-w-11');
    expect(Array.from(new FormData(form).entries())).toEqual([['branchId', 'main']]);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const first = await screen.findByRole('option', { name: 'Main · MAIN (default)' });
    const second = screen.getByRole('option', { name: 'Second · SECOND' });
    expect(screen.queryByRole('option', { name: 'Closed' })).not.toBeInTheDocument();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    await waitFor(() => expect(second).toHaveFocus());
    // jsdom needs the activation click that real browsers produce for Enter.
    fireEvent.keyDown(second, { key: 'Enter' });
    fireEvent.click(second, { detail: 0 });
    await waitFor(() => expect(trigger).toHaveTextContent('Second · SECOND'));
    expect(changed).toHaveBeenCalledExactlyOnceWith('second');
    expect(Array.from(new FormData(form).entries())).toEqual([['branchId', 'second']]);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findByRole('listbox');
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('preserves optional empty submission and restores its default on form reset', async () => {
    render(
      <form aria-label="Branch form">
        <RestaurantBranchSelect
          name="branchId"
          branches={branches}
          defaultValue="second"
          allowEmpty
        />
      </form>
    );
    const form = screen.getByRole('form') as HTMLFormElement;
    const trigger = screen.getByRole('combobox', { name: 'Branch' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const empty = await screen.findByRole('option', { name: 'No branch', exact: true });
    empty.focus();
    fireEvent.keyDown(empty, { key: 'Enter' });
    // jsdom does not generate the Enter activation click.
    fireEvent.click(empty, { detail: 0 });
    await waitFor(() => expect(trigger).toHaveTextContent('No branch'));
    expect(Array.from(new FormData(form).entries())).toEqual([['branchId', '']]);
    form.reset();
    await waitFor(() => expect(trigger).toHaveTextContent('Second · SECOND'));
    expect(Array.from(new FormData(form).entries())).toEqual([['branchId', 'second']]);
  });

  it.each([
    { state: 'loading', props: { loading: true }, message: 'Loading branches…' },
    { state: 'error', props: { error: true }, message: 'Branches unavailable — retry the page' },
    { state: 'empty', props: { branches: [] }, message: 'No active branches — create one first' },
  ])(
    'preserves the $state message and omits an unavailable branch from submission',
    ({ props, message }) => {
      render(
        <form aria-label="Branch form">
          <RestaurantBranchSelect
            name="branchId"
            branches={branches}
            value=""
            {...props}
            required
          />
        </form>
      );
      const trigger = screen.getByRole('combobox', { name: 'Branch' });
      expect(trigger).toBeDisabled();
      expect(trigger).toHaveTextContent(message);
      expect(
        Array.from(new FormData(screen.getByRole('form') as HTMLFormElement).entries())
      ).toEqual([]);
    }
  );
});
