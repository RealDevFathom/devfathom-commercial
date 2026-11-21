import { selectFieldControl } from '@/lib/testing/select-field';
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

    expect(
      selectFieldControl(
        screen.getByLabelText('Organization type', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('AGENCY');
    expect(
      selectFieldControl(
        screen.getByLabelText('Commercial package', {
          selector: ':not([data-select-field-native][aria-hidden="true"])',
        })
      )
    ).toHaveValue('agency-old');

    rerender(
      <PlatformCommandForm
        action="organization.update"
        fields={fields('RESTAURANT', 'agency-old', [
          { label: 'Restaurant New', value: 'restaurant-new', filterValue: 'RESTAURANT' },
        ])}
      />
    );

    await waitFor(() => {
      expect(
        selectFieldControl(
          screen.getByLabelText('Organization type', {
            selector: ':not([data-select-field-native][aria-hidden="true"])',
          })
        )
      ).toHaveValue('RESTAURANT');
      expect(
        selectFieldControl(
          screen.getByLabelText('Commercial package', {
            selector: ':not([data-select-field-native][aria-hidden="true"])',
          })
        )
      ).toHaveValue('restaurant-new');
    });
    expect(
      within(
        selectFieldControl(
          screen.getByLabelText('Commercial package', {
            selector: ':not([data-select-field-native][aria-hidden="true"])',
          })
        )
      ).getAllByRole('option', { hidden: true })
    ).toHaveLength(1);
    expect(
      within(
        selectFieldControl(
          screen.getByLabelText('Commercial package', {
            selector: ':not([data-select-field-native][aria-hidden="true"])',
          })
        )
      ).getByRole('option', { hidden: true })
    ).toHaveTextContent('Restaurant New');
  });
});
