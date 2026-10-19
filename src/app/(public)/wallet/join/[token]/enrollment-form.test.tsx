import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EnrollmentForm } from './enrollment-form';

describe('EnrollmentForm', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('moves through email, OTP and success states accessibly', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, message: 'sent', attemptId: 'attempt_1' }))
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, message: 'prepared' })));
    render(<EnrollmentForm token="wel_0123456789abcdefghjkmnpq" />);

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'guest@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send my code' }));
    await screen.findByLabelText('Six-digit code');
    fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create my wallet pass' }));

    await screen.findByRole('status');
    expect(screen.getByText('You’re enrolled')).toBeInTheDocument();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
  });

  it('announces generic errors and preserves the entered email', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, message: 'This enrollment request could not be completed.' }),
        { status: 400 }
      )
    );
    render(<EnrollmentForm token="wel_0123456789abcdefghjkmnpq" />);
    const input = screen.getByLabelText('Email address');
    fireEvent.change(input, { target: { value: 'guest@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send my code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be completed');
    expect(input).toHaveValue('guest@example.test');
  });
});
