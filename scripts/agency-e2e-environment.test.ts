import { describe, expect, it } from 'vitest';

import { agencyE2eEnvironment } from './agency-e2e-environment';

const valid = {
  AGENCY_E2E: '1',
  AGENCY_E2E_ADMIN_EMAIL: 'admin@example.test',
  AGENCY_E2E_ADMIN_PASSWORD: 'not-a-real-password',
  AGENCY_E2E_DATABASE_URL: 'postgresql://localhost:55432/agency_e2e_test',
  EMAIL_DELIVERY_MODE: 'send',
  BREVO_API_KEY: 'not-a-real-key',
  BREVO_SENDER_EMAIL: 'sender@example.test',
  NEXT_PUBLIC_APP_URL: 'https://agency.example.test',
};

describe('Agency E2E email preflight', () => {
  it.each([
    ['BREVO_API_KEY', undefined, 'BREVO_API_KEY is required'],
    ['BREVO_SENDER_EMAIL', undefined, 'BREVO_SENDER_EMAIL is required'],
    ['EMAIL_DELIVERY_MODE', 'capture', 'EMAIL_DELIVERY_MODE=send is required'],
    ['NEXT_PUBLIC_APP_URL', 'http://agency.example.test', 'must use HTTPS'],
  ] as const)('rejects invalid %s', (name, value, message) => {
    expect(() => agencyE2eEnvironment({ ...valid, [name]: value })).toThrow(message);
  });

  it('accepts a real-provider configuration with an HTTPS application URL', () => {
    expect(agencyE2eEnvironment(valid).NEXT_PUBLIC_APP_URL).toBe(valid.NEXT_PUBLIC_APP_URL);
  });
});
