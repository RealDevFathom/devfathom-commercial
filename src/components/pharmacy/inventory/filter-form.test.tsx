import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

import { BranchField, FilterForm, filterHref } from './filter-form';

const branches = [
  { id: 'main', name: 'Main', city: 'Lahore' },
  { id: 'north', name: 'North', city: 'Karachi' },
];

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function Filters({ autoSubmit = false }: { autoSubmit?: boolean }) {
  return (
    <FilterForm action="/pharmacy/inventory/expiry" autoSubmit={autoSubmit} label="Filters">
      <BranchField branches={branches} value="main" />
      <label>
        Expiring within
        <select defaultValue="90" name="within">
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
      </label>
      <button type="submit">Show stock</button>
    </FilterForm>
  );
}

describe('FilterForm', () => {
  it('applies filters by replacing the history entry, never pushing one', () => {
    render(<Filters />);
    fireEvent.click(screen.getByRole('button', { name: 'Show stock' }));
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(
      '/pharmacy/inventory/expiry?branch=main&within=90'
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('applies a changed window straight away when auto-submit is on', () => {
    render(<Filters autoSubmit />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Expiring within' }), {
      target: { value: '30' },
    });
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(
      '/pharmacy/inventory/expiry?branch=main&within=30'
    );
    expect(screen.getByRole('button', { name: 'Show stock' })).toBeVisible();
  });

  it('waits for the button when auto-submit is off', () => {
    render(<Filters />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Expiring within' }), {
      target: { value: '30' },
    });
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('falls back to a plain GET form without JavaScript', () => {
    render(<Filters />);
    const form = screen.getByRole('form', { name: 'Filters' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/pharmacy/inventory/expiry');
  });
});

describe('BranchField', () => {
  it('offers a picker when there is more than one branch', () => {
    render(<BranchField branches={branches} value="north" />);
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveValue('north');
  });

  it('shows the only branch as text and still submits its id', () => {
    const { container } = render(<BranchField branches={[branches[0]!]} value="main" />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Main · Lahore')).toBeVisible();
    expect(container.querySelector('input[type="hidden"][name="branch"]')).toHaveValue('main');
  });
});

describe('filterHref', () => {
  it('returns the bare route for an empty form', () => {
    expect(filterHref('/pharmacy/inventory', new FormData())).toBe('/pharmacy/inventory');
  });
});
