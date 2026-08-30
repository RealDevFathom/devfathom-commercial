import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';

export const restaurantE2eCredentials = {
  organizationId: 'org_chai_chowk',
  branchId: 'branch_restaurant_e2e',
  operator: { staffProfileId: 'staff_restaurant_e2e_operator', pin: '424242' },
  manager: { staffProfileId: 'staff_restaurant_e2e_manager', pin: '848484' },
  pos: { deviceId: 'device_restaurant_e2e_pos', secret: 'rdk_restaurant_e2e_pos_local_ci_only' },
  kds: { deviceId: 'device_restaurant_e2e_kds', secret: 'rdk_restaurant_e2e_kds_local_ci_only' },
  branchA2Id: 'branch_restaurant_e2e_a2',
  table: { id: 'table_restaurant_e2e_a1_12', name: 'Table 12' },
  modifier: { optionId: 'modifier_option_restaurant_e2e_spicy', name: 'Spicy', delta: '1.50' },
  menuItem: { name: 'Chicken Tikka Bun', unitPrice: '12.50' },
  expected: { twoItemTotal: '28.00' },
  seams: {
    servicePolicy: 'service-policy-pending-integration',
    refundEvidence: 'refund-evidence-derived-from-settled-bill',
  },
} as const;

export function e2eIdempotencyKey(operation: string, discriminator: string | number) {
  return `restaurant-integrated-${operation}-${discriminator}`;
}

export async function installSeededTerminalCookie(
  context: BrowserContext,
  device: typeof restaurantE2eCredentials.pos | typeof restaurantE2eCredentials.kds,
  baseUrl = process.env.PLAYWRIGHT_BASE_URL ??
    `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT ?? 4319)}`
) {
  const origin = new URL(baseUrl);
  await context.addCookies([
    {
      name: 'devfathom-terminal',
      value: device.secret,
      url: origin.origin,
      httpOnly: true,
      sameSite: 'Strict',
      secure: origin.protocol === 'https:',
    },
  ]);
}

export async function assertTerminalSecretIsBrowserIsolated(
  page: import('@playwright/test').Page,
  secret: string
) {
  await expect(page.locator('body')).not.toContainText(secret);
  const browserState = await page.evaluate(() => ({
    dom: document.documentElement.outerHTML,
    cookie: document.cookie,
    storage: [...Object.entries(localStorage), ...Object.entries(sessionStorage)],
  }));
  expect(browserState.dom).not.toContain(secret);
  expect(browserState.cookie).not.toContain(secret);
  expect(JSON.stringify(browserState.storage)).not.toContain(secret);
}

export type RestaurantTerminalFixture = {
  deviceId: string;
  deviceSecret: string;
  sessionToken: string;
  headers: { authorization: string; 'x-terminal-session': string };
};

async function establishTerminal(
  request: APIRequestContext,
  device: typeof restaurantE2eCredentials.pos | typeof restaurantE2eCredentials.kds
): Promise<RestaurantTerminalFixture> {
  const authorization = `Bearer ${device.secret}`;
  const established = await request.post('/api/restaurant/terminal/establish', {
    headers: { authorization },
  });
  expect(established.status()).toBe(201);
  const body = (await established.json()) as { sessionToken: string; device: { id: string } };
  expect(body.device.id).toBe(device.deviceId);

  const unlocked = await request.post('/api/restaurant/terminal/unlock', {
    headers: { authorization, 'x-terminal-session': body.sessionToken },
    data: {
      staffProfileId: restaurantE2eCredentials.operator.staffProfileId,
      type: 'PIN',
      secret: restaurantE2eCredentials.operator.pin,
    },
  });
  expect(unlocked.status()).toBe(200);

  return {
    deviceId: device.deviceId,
    deviceSecret: device.secret,
    sessionToken: body.sessionToken,
    headers: { authorization, 'x-terminal-session': body.sessionToken },
  };
}

export function establishPosFixture(request: APIRequestContext) {
  return establishTerminal(request, restaurantE2eCredentials.pos);
}

export function establishKdsFixture(request: APIRequestContext) {
  return establishTerminal(request, restaurantE2eCredentials.kds);
}
