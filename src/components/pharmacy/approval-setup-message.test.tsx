import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import {
  APPROVAL_AUTHENTICATOR_SETUP_MESSAGE,
  APPROVAL_AUTHENTICATOR_SETUP_PATH,
} from '@/lib/auth/session-state';
import { NO_PIN_SET_MESSAGE, OWN_PIN_PATH } from '@/lib/pharmacy/own-pin-policy';
import { CounterTenderPanel } from './counter/counter-tender-panel';

it.each([
  [NO_PIN_SET_MESSAGE, 'Set up your PIN', OWN_PIN_PATH],
  [
    APPROVAL_AUTHENTICATOR_SETUP_MESSAGE,
    'Set up your authenticator app',
    APPROVAL_AUTHENTICATOR_SETUP_PATH,
  ],
])('links the rejected approval to the matching setup screen: %s', (message, name, href) => {
  render(
    <CounterTenderPanel
      balanceMinor={100}
      state="ready"
      blocked={false}
      onRetry={vi.fn()}
      onTender={vi.fn()}
      recoveryOutcome={{ status: 'rejected', message: `Payment was not accepted. ${message}` }}
    />
  );
  expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
  expect(screen.getByText(new RegExp(message))).toBeVisible();
});
