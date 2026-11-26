import { afterEach, expect, it, vi } from 'vitest';
import {
  counterApprovalHeaders,
  establishCounterSession,
  unbindCounterBrowser,
} from './counter-offline-transport';

afterEach(() => vi.unstubAllGlobals());

it('sends the in-memory till proof only for pharmacy sale mutations and clears it on unbind', async () => {
  const mutation = [{ type: 'mutation', path: 'pharmacySales.tender' }];
  const proof = { sessionToken: 'synthetic-session', device: { id: 'till' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(proof))
  );
  expect(counterApprovalHeaders(mutation)).toEqual({});
  await establishCounterSession();
  expect(counterApprovalHeaders(mutation)).toEqual({
    'x-pharmacy-approval-device': proof.device.id,
    'x-terminal-session': proof.sessionToken,
  });
  expect(counterApprovalHeaders([{ type: 'query', path: 'pharmacySales.tenderOutcome' }])).toEqual(
    {}
  );
  expect(counterApprovalHeaders([{ type: 'mutation', path: 'profile.update' }])).toEqual({});
  await unbindCounterBrowser();
  expect(counterApprovalHeaders(mutation)).toEqual({});
});
