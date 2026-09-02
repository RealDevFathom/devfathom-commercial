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
    expect(screen.getByText('Use 24-hour time, e.g. 09:30')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs attention');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('placeholder', 'HH:MM');
  });
});
