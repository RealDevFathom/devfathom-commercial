import { selectFieldControl } from '@/lib/testing/select-field';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ProfilePanel } from './profile-panel';

vi.mock('./action-form', () => ({
  MarketingActionForm: ({
    children,
    label,
    operation,
  }: {
    children: ReactNode;
    label: string;
    operation: string;
  }) => (
    <form data-operation={operation}>
      {children}
      <button>{label}</button>
    </form>
  ),
}));
afterEach(cleanup);

it('offers a configurable checklist and manual-post reply drafts without a post control', () => {
  render(<ProfilePanel branchId="branch-a" />);
  expect(screen.getByRole('heading', { name: 'Google Business Profile' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check profile' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Draft reply' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /post|publish/i })).toBeNull();
  expect(selectFieldControl((screen.getByLabelText('Target photo count', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement)).value).toBe('10');
  expect(screen.getByLabelText('Primary category is Pharmacy', { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeTruthy();
  expect(screen.queryByLabelText(/review text/i, { selector: ':not([data-select-field-native][aria-hidden="true"])' })).toBeNull();
  expect(screen.getByText(/never posts/)).toBeTruthy();
});
