import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageHeader } from './page-header';

describe('PageHeader', () => {
  it('renders its content and actions with the responsive layout contract', () => {
    render(
      <PageHeader
        heading="Orders"
        description="Manage restaurant orders."
        actions={<button type="button">Create order</button>}
      />
    );

    const heading = screen.getByRole('heading', { level: 1, name: 'Orders' });
    const action = screen.getByRole('button', { name: 'Create order' });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Manage restaurant orders.')).toBeVisible();
    expect(action).toBeVisible();

    expect(heading.closest('[data-slot="page-header"]')).toHaveClass('flex-col', '2xl:flex-row');
    expect(heading.parentElement?.parentElement).toHaveClass('w-full', 'min-w-0', '2xl:flex-1');
    expect(action.parentElement).toHaveClass(
      'w-full',
      'min-w-0',
      'flex-wrap',
      '2xl:w-auto',
      '2xl:justify-end'
    );
    expect(action.parentElement).not.toHaveClass('shrink-0');
  });
});
