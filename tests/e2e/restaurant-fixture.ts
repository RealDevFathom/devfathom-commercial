import { expect, type APIRequestContext } from '@playwright/test';

export const restaurantE2eCredentials = {
  organizationId: 'org_chai_chowk',
  branchId: 'branch_restaurant_e2e',
  operator: { staffProfileId: 'staff_restaurant_e2e_operator', pin: '424242' },
  manager: { staffProfileId: 'staff_restaurant_e2e_manager', pin: '848484' },
  pos: { deviceId: 'device_restaurant_e2e_pos', secret: 'rdk_restaurant_e2e_pos_local_ci_only' },
  kds: { deviceId: 'device_restaurant_e2e_kds', secret: 'rdk_restaurant_e2e_kds_local_ci_only' },
} as const;

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
