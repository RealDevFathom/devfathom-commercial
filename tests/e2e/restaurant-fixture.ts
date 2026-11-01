import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';

export const restaurantE2eCredentials = {
  organizationId: 'org_chai_chowk',
  branchId: 'branch_restaurant_e2e',
  operator: { staffProfileId: 'staff_restaurant_e2e_operator', pin: '424242' },
  deniedOperator: { staffProfileId: 'staff_restaurant_e2e_delivery_denied', pin: '626262' },
  deliveryOperator: { staffProfileId: 'staff_restaurant_e2e_delivery_operator', pin: '737373' },
  deliveryDeniedOperator: {
    staffProfileId: 'staff_restaurant_e2e_delivery_capability_denied',
    pin: '515151',
  },
  manager: { staffProfileId: 'staff_restaurant_e2e_manager', pin: '848484' },
  pos: {
    deviceId: 'device_restaurant_e2e_pos',
    secret: 'rdk_restaurant_e2e_pos_local_ci_only',
    clientIp: '198.51.100.10',
  },
  kds: {
    deviceId: 'device_restaurant_e2e_kds',
    secret: 'rdk_restaurant_e2e_kds_local_ci_only',
    clientIp: '198.51.100.11',
  },
  /**
   * WHA-1542 — the per-case registers `scripts/seed-restaurant-e2e.ts` enrols
   * (`RESTAURANT_E2E.caseTerminalCount`). The unlock burst gate keys on
   * `<deviceId>:<staffProfileId>` and carries no client address, so a serial
   * lane that binds one operator to ONE register runs that bucket out; a case
   * that takes its own register never shares one. Keep this list and the seed's
   * `caseRegisterDevice(index)` in step.
   */
  caseRegisters: Array.from({ length: 12 }, (_unused, index) => ({
    deviceId: `device_restaurant_e2e_pos_case_${index}`,
    secret: `rdk_restaurant_e2e_pos_case_${index}_local_ci_only`,
  })),
  branchA2Id: 'branch_restaurant_e2e_a2',
  table: { id: 'table_restaurant_e2e_a1_12', name: 'Table 12' },
  customer: { id: 'customer_restaurant_e2e', name: 'E2E Guest' },
  delivery: {
    branchId: 'branch_restaurant_e2e_a2',
    branchName: 'DHA Café',
    pos: {
      deviceId: 'device_restaurant_e2e_delivery_pos',
      secret: 'rdk_restaurant_e2e_delivery_pos_local_ci_only',
      clientIp: '198.51.100.12',
    },
    kds: {
      deviceId: 'device_restaurant_e2e_delivery_kds',
      secret: 'rdk_restaurant_e2e_delivery_kds_local_ci_only',
      clientIp: '198.51.100.13',
    },
    addressId: 'customer_address_restaurant_e2e',
    zoneId: 'delivery_zone_restaurant_e2e_isolated',
    zoneName: 'DHA Delivery Lane',
    fee: '3.50',
  },
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

export function terminalBrowserBaseUrl(
  baseUrl = process.env.PLAYWRIGHT_BASE_URL ??
    `http://localhost:${Number(process.env.PLAYWRIGHT_PORT ?? 4319)}`
) {
  const url = new URL(baseUrl);
  url.hostname = 'localhost';
  return url.origin;
}

export async function installSeededTerminalCookie(
  context: BrowserContext,
  device: { deviceId: string; secret: string; clientIp: string },
  baseUrl = process.env.PLAYWRIGHT_BASE_URL ??
    `http://127.0.0.1:${Number(process.env.PLAYWRIGHT_PORT ?? 4319)}`
) {
  const origin = new URL(baseUrl);
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': device.clientIp });
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
  headers: {
    authorization: string;
    'x-terminal-session': string;
    'x-forwarded-for': string;
    'x-pos-composer-proof': string;
  };
};

async function establishTerminal(
  request: APIRequestContext,
  device: { deviceId: string; secret: string; clientIp: string },
  staff: { staffProfileId: string; pin: string } = restaurantE2eCredentials.operator
): Promise<RestaurantTerminalFixture> {
  const authorization = `Bearer ${device.secret}`;
  const established = await request.post('/api/restaurant/terminal/establish', {
    headers: { authorization, 'x-forwarded-for': device.clientIp },
  });
  expect(established.status()).toBe(201);
  const body = (await established.json()) as { sessionToken: string; device: { id: string } };
  expect(body.device.id).toBe(device.deviceId);

  const unlocked = await request.post('/api/restaurant/terminal/unlock', {
    headers: {
      authorization,
      'x-terminal-session': body.sessionToken,
      'x-forwarded-for': device.clientIp,
    },
    data: {
      staffProfileId: staff.staffProfileId,
      type: 'PIN',
      secret: staff.pin,
    },
  });
  expect(unlocked.status()).toBe(200);
  const { composerProof } = (await unlocked.json()) as { composerProof: string };
  expect(typeof composerProof).toBe('string');

  return {
    deviceId: device.deviceId,
    deviceSecret: device.secret,
    sessionToken: body.sessionToken,
    headers: {
      authorization,
      'x-terminal-session': body.sessionToken,
      'x-forwarded-for': device.clientIp,
      'x-pos-composer-proof': composerProof,
    },
  };
}

/**
 * Establish a terminal against an explicitly supplied device descriptor. The
 * named helpers below are the normal entry points; this one exists for specs
 * that must vary the `clientIp` a seeded device presents, because the terminal
 * transport throttles pre-auth per IP and a long serial lane otherwise spends
 * one bucket across every case.
 */
export function establishTerminalFixture(
  request: APIRequestContext,
  device: { deviceId: string; secret: string; clientIp: string },
  staff?: { staffProfileId: string; pin: string }
) {
  return establishTerminal(request, device, staff);
}

export function establishPosFixture(request: APIRequestContext) {
  return establishTerminal(request, restaurantE2eCredentials.pos);
}

export function establishKdsFixture(request: APIRequestContext) {
  return establishTerminal(request, restaurantE2eCredentials.kds);
}

export function establishDeliveryPosFixture(request: APIRequestContext) {
  return establishTerminal(
    request,
    restaurantE2eCredentials.delivery.pos,
    restaurantE2eCredentials.deliveryOperator
  );
}

export function establishDeliveryKdsFixture(request: APIRequestContext) {
  return establishTerminal(
    request,
    restaurantE2eCredentials.delivery.kds,
    restaurantE2eCredentials.deliveryOperator
  );
}
