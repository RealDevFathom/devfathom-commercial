import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlatformCommandForm, type CommandField } from './platform-command-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

function fields(
  vertical: string,
  packageId: string,
  packages: Array<{ label: string; value: string; filterValue: string }>
): CommandField[] {
  return [
    {
      name: 'vertical',
      label: 'Organization type',
      type: 'select',
      required: true,
      defaultValue: vertical,
      options: [
        { label: 'Agency', value: 'AGENCY' },
        { label: 'Restaurant', value: 'RESTAURANT' },
      ],
    },
    {
      name: 'packageId',
      label: 'Commercial package',
      type: 'select',
      required: true,
      defaultValue: packageId,
      filterBy: 'vertical',
      options: packages,
    },
  ];
}

describe('PlatformCommandForm refreshed fields', () => {
  it('reconciles controlled selects with refreshed defaults, options, and parent filters', async () => {
    const { rerender } = render(
      <PlatformCommandForm
        action="organization.update"
        fields={fields('AGENCY', 'agency-old', [
          { label: 'Agency Old', value: 'agency-old', filterValue: 'AGENCY' },
        ])}
      />
    );

    expect(screen.getByLabelText('Organization type')).toHaveValue('AGENCY');
    expect(screen.getByLabelText('Commercial package')).toHaveValue('agency-old');

    rerender(
      <PlatformCommandForm
        action="organization.update"
        fields={fields('RESTAURANT', 'agency-old', [
          { label: 'Restaurant New', value: 'restaurant-new', filterValue: 'RESTAURANT' },
        ])}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Organization type')).toHaveValue('RESTAURANT');
      expect(screen.getByLabelText('Commercial package')).toHaveValue('restaurant-new');
    });
    expect(within(screen.getByLabelText('Commercial package')).getAllByRole('option')).toHaveLength(
      1
    );
    expect(
      within(screen.getByLabelText('Commercial package')).getByRole('option')
    ).toHaveTextContent('Restaurant New');
  });
});
