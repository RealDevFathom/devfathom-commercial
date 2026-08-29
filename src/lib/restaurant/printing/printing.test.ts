import { describe, expect, it } from 'vitest';

import type { PrintJob, PrintRoutingConfig } from './contract';
import { renderEscPos } from './esc-pos';
import { PrintBridgeService } from './service';
import { SimulatedPrintBridgeAdapter } from './stub';

const job: PrintJob = {
  branchId: 'branch-a',
  stationId: 'bar',
  idempotencyKey: 'order-42:bar:v1',
  document: {
    type: 'BAR_TICKET',
    reference: 'KOT 42',
    title: 'BAR',
    createdAt: '2026-08-29T08:00:00.000Z',
    lines: [{ quantity: 2, label: 'Lime soda' }],
  },
};
const config: PrintRoutingConfig = {
  branchId: 'branch-a',
  routes: [
    { documentType: 'BAR_TICKET', stationId: null, printerId: 'fallback', enabled: true },
    { documentType: 'BAR_TICKET', stationId: 'bar', printerId: 'bar-printer', enabled: true },
  ],
};

describe('ESC/POS printing', () => {
  it('matches the golden byte fixture', () => {
    expect(Buffer.from(renderEscPos(job.document)).toString('hex')).toBe(
      '1b401b61011b45014241520a4b4f542034320a1b45001b61002d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d0a322078204c696d6520736f64610a0a0a0a1d5600'
    );
  });

  it('prefers station routing and never duplicates a completed replay', async () => {
    const adapter = new SimulatedPrintBridgeAdapter();
    const service = new PrintBridgeService(adapter);
    expect(await service.submit('org-a', config, job)).toMatchObject({
      status: 'PRINTED',
      printerId: 'bar-printer',
      replayed: false,
    });
    expect(await service.submit('org-a', config, job)).toMatchObject({
      status: 'PRINTED',
      replayed: true,
    });
    expect(adapter.deliveries).toHaveLength(1);
  });

  it('coalesces concurrent submissions under the same idempotency key', async () => {
    const adapter = new SimulatedPrintBridgeAdapter();
    const service = new PrintBridgeService(adapter);
    const [first, second] = await Promise.all([
      service.submit('org-a', config, job),
      service.submit('org-a', config, job),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(adapter.deliveries).toHaveLength(1);
  });

  it('reports offline, permits retry, and completes once without duplication', async () => {
    const adapter = new SimulatedPrintBridgeAdapter();
    adapter.setOffline('bar-printer', true);
    const service = new PrintBridgeService(adapter);
    expect(await service.submit('org-a', config, job)).toEqual({
      status: 'OFFLINE',
      retryable: true,
      replayed: false,
    });
    adapter.setOffline('bar-printer', false);
    expect(await service.submit('org-a', config, job)).toMatchObject({
      status: 'PRINTED',
      replayed: false,
    });
    expect(adapter.deliveries).toHaveLength(1);
  });

  it('fails closed for missing routes and branch-mismatched configuration', async () => {
    const service = new PrintBridgeService(new SimulatedPrintBridgeAdapter());
    await expect(
      service.submit('org-a', { branchId: 'branch-a', routes: [] }, job)
    ).resolves.toMatchObject({ status: 'NO_PRINTER' });
    await expect(
      service.submit('org-a', { ...config, branchId: 'branch-b' }, job)
    ).resolves.toMatchObject({ status: 'NO_PRINTER' });
  });

  it('scopes idempotency by organization', async () => {
    const adapter = new SimulatedPrintBridgeAdapter();
    const service = new PrintBridgeService(adapter);
    await service.submit('org-a', config, job);
    await service.submit('org-b', config, job);
    expect(adapter.deliveries).toHaveLength(2);
  });
});
