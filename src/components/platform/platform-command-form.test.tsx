import { selectFieldControl } from '@/lib/testing/select-field';
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

    expect(selectFieldControl(screen.getByLabelText('Operator notes', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('');
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

    const input = screen.getByLabelText('Business-day cutoff', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    fireEvent.change(selectFieldControl(input), { target: { value: '09:30' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByTestId('platform-field-error-businessDayCutoff')).toHaveTextContent(
      'Use 24-hour time, e.g. 09:30'
    );
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs attention');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('placeholder', 'HH:MM');
  });

  it('flags a value that does not match the field pattern inline', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <PlatformCommandForm
        action="organization.update"
        fields={[{ name: 'code', label: 'Region code', pattern: '[A-Z]{3}' }]}
      />
    );

    const input = screen.getByLabelText('Region code', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    expect(input).toHaveAttribute('pattern', '[A-Z]{3}');
    fireEvent.change(selectFieldControl(input), { target: { value: 'abc' } });
    fireEvent.submit(input.closest('form')!);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    expect(screen.getByTestId('platform-field-error-code')).toHaveTextContent(
      'Region code has an invalid format.'
    );
  });

  it('allows blank optional constrained fields and omits them from the payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <PlatformCommandForm
        action="operator.upsert"
        fields={[
          { name: 'locale', label: 'Locale', minLength: 2, maxLength: 20 },
          {
            name: 'password',
            label: 'Password',
            type: 'password',
            minLength: 12,
            maxLength: 256,
          },
          { name: 'code', label: 'Code', minLength: 3, disabled: true },
        ]}
      />
    );

    fireEvent.submit(screen.getByLabelText('Password', { selector: ':not([data-select-field-native][aria-hidden="true"])' }).closest('form')!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).payload).toEqual({});
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('counts password whitespace as the server does', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <PlatformCommandForm
        action="operator.upsert"
        fields={[
          {
            name: 'password',
            label: 'Password',
            type: 'password',
            minLength: 12,
            maxLength: 256,
          },
        ]}
      />
    );
    const input = screen.getByLabelText('Password', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    fireEvent.change(selectFieldControl(input), { target: { value: 'short' } });
    fireEvent.submit(input.closest('form')!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input).toHaveAccessibleDescription('Password must be at least 12 characters.');

    fireEvent.change(selectFieldControl(input), { target: { value: ' padded-pass ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).payload.password).toBe(' padded-pass ');
  });

  it('associates each reason error with its own form', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <>
        <PlatformCommandForm
          action="organization.permission"
          fields={[{ name: 'reason', label: 'Override reason', required: true, minLength: 5 }]}
        />
        <PlatformCommandForm
          action="commercial.contract.status"
          fields={[{ name: 'reason', label: 'Contract reason', required: true, minLength: 5 }]}
        />
      </>
    );
    const overrideReason = screen.getByLabelText('Override reason', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    const contractReason = screen.getByLabelText('Contract reason', { selector: ':not([data-select-field-native][aria-hidden="true"])' });
    fireEvent.submit(overrideReason.closest('form')!);
    fireEvent.submit(contractReason.closest('form')!);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(overrideReason).toHaveAccessibleDescription(
      'Override reason must be at least 5 characters.'
    );
    expect(contractReason).toHaveAccessibleDescription(
      'Contract reason must be at least 5 characters.'
    );
    expect(overrideReason.getAttribute('aria-describedby')).not.toBe(
      contractReason.getAttribute('aria-describedby')
    );
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

    fireEvent.change(selectFieldControl(screen.getByPlaceholderText('Search city or IANA timezone…')), {
      target: { value: 'London' },
    });
    fireEvent.click(screen.getByText('Europe/London'));

    expect(screen.getByRole('button', { name: 'Timezone' })).toHaveTextContent('Europe/London');
    expect(selectFieldControl(document.querySelector('input[name="timezone"]'))).toHaveValue('Europe/London');
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
  it('renders field help with the contrast-checked muted text token', () => {
    render(
      <PlatformCommandForm
        action="operator.upsert"
        fields={[
          {
            name: 'password',
            label: 'Temporary password',
            type: 'password',
            help: 'At least 12 characters.',
          },
        ]}
      />
    );

    const help = screen.getByText('At least 12 characters.');
    expect(help).toHaveClass('text-text-muted');
    expect(help).not.toHaveClass('text-text-faint');
  });
});
