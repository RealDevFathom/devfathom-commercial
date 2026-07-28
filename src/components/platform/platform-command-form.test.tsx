import { render, screen } from '@testing-library/react';
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
});
