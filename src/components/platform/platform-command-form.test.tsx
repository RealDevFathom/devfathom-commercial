import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlatformCommandForm } from './platform-command-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn() },
}));

describe('PlatformCommandForm', () => {
  it('renders nullable textareas as empty rather than the string null', () => {
    render(
      <PlatformCommandForm
        action="organization.update"
        fields={[
          {
            name: 'notes',
            label: 'Operator notes',
            type: 'textarea',
            defaultValue: null,
          },
        ]}
      />
    );

    expect(screen.getByLabelText('Operator notes')).toHaveValue('');
  });

  it('renders an invalid time inline and focuses its exact field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: 'The command payload is invalid.',
          details: [
            {
              code: 'invalid_format',
              path: ['businessDayCutoff'],
              message: 'Use 24-hour time, e.g. 09:30',
            },
          ],
          fieldErrors: { businessDayCutoff: 'Use 24-hour time, e.g. 09:30' },
        }),
      })
    );
    render(
      <PlatformCommandForm
        action="organization.restaurant.setup"
        fields={[
          {
            name: 'businessDayCutoff',
            label: 'Business-day cutoff',
            format: 'time24',
          },
        ]}
      />
    );

    const input = screen.getByLabelText('Business-day cutoff');
    fireEvent.change(input, { target: { value: '09:30' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByTestId('platform-field-error-businessDayCutoff')).toHaveTextContent(
      'Use 24-hour time, e.g. 09:30'
    );
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs attention');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('placeholder', 'HH:MM');
  });

  it('searches grouped timezones and preserves the selected IANA value', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    render(
      <PlatformCommandForm
        action="organization.restaurant.setup"
        fields={[
          {
            name: 'timezone',
            label: 'Timezone',
            type: 'searchable-select',
            required: true,
            defaultValue: 'Asia/Karachi',
            options: [
              { label: 'UTC', value: 'UTC' },
              { label: 'Asia/Karachi', value: 'Asia/Karachi' },
              { label: 'Europe/London', value: 'Europe/London' },
            ],
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }));
    expect(screen.getByRole('group', { name: 'Asia' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Europe' })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search city or IANA timezone…'), {
      target: { value: 'London' },
    });
    fireEvent.click(screen.getByText('Europe/London'));

    expect(screen.getByRole('button', { name: 'Timezone' })).toHaveTextContent('Europe/London');
    expect(document.querySelector('input[name="timezone"]')).toHaveValue('Europe/London');
  });

  it('renders a custom timezone issue inline and focuses the timezone combobox', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          error: 'The command payload is invalid.',
          details: [
            {
              code: 'custom',
              path: ['timezone'],
              message: 'Choose a valid IANA timezone.',
            },
          ],
          fieldErrors: { timezone: 'Choose a valid IANA timezone.' },
        }),
      })
    );
    render(
      <PlatformCommandForm
        action="organization.restaurant.setup"
        fields={[
          {
            name: 'timezone',
            label: 'IANA timezone',
            type: 'searchable-select',
            required: true,
            defaultValue: 'Asia/Karachi',
            options: [{ label: 'Asia/Karachi', value: 'Asia/Karachi' }],
          },
        ]}
      />
    );

    const select = screen.getByRole('button', { name: 'IANA timezone' });
    fireEvent.submit(select.closest('form')!);

    await waitFor(() => expect(select).toHaveFocus());
    expect(screen.getByText('Choose a valid IANA timezone.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs attention');
    expect(select).toHaveAttribute('data-invalid', '');
    expect(select).toHaveAccessibleDescription('Choose a valid IANA timezone.');
    fireEvent.click(select);
    const search = await screen.findByRole('combobox');
    expect(search).toHaveAttribute('aria-invalid', 'true');
    expect(search).toHaveAccessibleDescription('Choose a valid IANA timezone.');
  });
});
