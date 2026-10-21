// @vitest-environment node
import { expect, it } from 'vitest';
import { createSimulatedCameraGateway } from './camera-gateway.simulated';
it('extends snapshots while retaining discovery and independent bytes', async () => {
  const adapter = createSimulatedCameraGateway();
  const cameras = await adapter.listCameras();
  expect(cameras).toHaveLength(1);
  for (const id of ['sim-camera-1', 'sim-fridge-1', 'sim-kitchen-1', 'sim-counter-1']) {
    const first = await adapter.getSnapshot!(id);
    const second = await adapter.getSnapshot!(id);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first[0] = 0;
    expect(second[0]).toBe(137);
  }
  await expect(adapter.getSnapshot!('unknown')).rejects.toThrow('Camera snapshot unavailable.');
  expect(await adapter.listCameras()).toEqual(cameras);
});
