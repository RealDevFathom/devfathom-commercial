import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/http-origin', () => ({
  publicRequestOrigin: () => 'https://www.devfathom.com',
}));

import { isDemoMutationOrigin, isDemoProcedureBlocked } from './isolation';

describe('demo isolation policy', () => {
  it.each([
    ['apiTokens.list', 'query'],
    ['email.connect', 'mutation'],
    ['restaurantCameras.list', 'query'],
    ['restaurantMenuImport.create', 'mutation'],
    ['webhooks.create', 'mutation'],
    ['organizationAdmin.updateEmail', 'mutation'],
    ['restaurantDevices.initiateEnrollment', 'mutation'],
    ['restaurantPayments.saveTerminalConfig', 'mutation'],
    ['restaurantPayments.rotateTerminalWebhookSecret', 'mutation'],
    ['restaurantStaff.issueCredential', 'mutation'],
    ['team.inviteMember', 'mutation'],
    ['team.updateProfile', 'mutation'],
  ] as const)('blocks %s', (path, type) => {
    expect(isDemoProcedureBlocked(path, type)).toBe(true);
  });

  it.each([
    ['restaurantOrders.list', 'query'],
    ['restaurantOrders.open', 'mutation'],
    ['restaurantInventory.snapshot', 'query'],
    ['restaurantPayments.applyTender', 'mutation'],
    ['restaurantDevices.list', 'query'],
    ['restaurantStaff.listDirectory', 'query'],
    ['restaurantStaff.listJobRoles', 'query'],
    ['restaurantShifts.publish', 'mutation'],
    ['organizationAdmin.updateBrand', 'mutation'],
  ] as const)('keeps the product workflow %s available', (path, type) => {
    expect(isDemoProcedureBlocked(path, type)).toBe(false);
  });

  it('accepts only the exact request origin', () => {
    expect(
      isDemoMutationOrigin(
        new Request('https://www.devfathom.com/demo/restaurants/reset', {
          headers: { origin: 'https://www.devfathom.com', 'sec-fetch-site': 'same-origin' },
        })
      )
    ).toBe(true);
    expect(
      isDemoMutationOrigin(
        new Request('https://www.devfathom.com/demo/restaurants/reset', {
          headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        })
      )
    ).toBe(false);
  });
});
