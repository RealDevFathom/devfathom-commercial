import { afterEach, expect, it, vi } from 'vitest';
import {
  counterApprovalHeaders,
  activateCounterApprovalSession,
  clearCounterApprovalSession,
  establishCounterSession,
  unbindCounterBrowser,
} from './counter-offline-transport';

afterEach(() => vi.unstubAllGlobals());

it('sends the in-memory till proof only for pharmacy sale mutations and clears it on unbind', async () => {
  const mutation = [{ type: 'mutation', path: 'pharmacySales.tender' }];
  const enrolled = { deviceId: 'till', organizationId: 'org', branchId: 'branch' };
  const expiresAt = Date.now() + 3_600_000;
  const token = btoa(JSON.stringify({ ...enrolled, expiresAt })) + '.fixture';
  const proof = { sessionToken: token, device: { id: 'till' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path) =>
      Response.json(path.endsWith('/approval-proof') ? { proof: 'test-attestation' } : proof)
    )
  );
  expect(await counterApprovalHeaders(mutation)).toEqual({});
  const session = await establishCounterSession();
  expect(await counterApprovalHeaders(mutation)).toEqual({});
  activateCounterApprovalSession(enrolled, session.sessionToken);
  expect(await counterApprovalHeaders(mutation)).toEqual({
    'x-pharmacy-approval-device': proof.device.id,
    'x-terminal-session': proof.sessionToken,
    'x-pharmacy-approval-proof': 'test-attestation',
  });
  expect(
    await counterApprovalHeaders([{ type: 'query', path: 'pharmacySales.tenderOutcome' }])
  ).toEqual({});
  expect(await counterApprovalHeaders([{ type: 'mutation', path: 'profile.update' }])).toEqual({});
  vi.spyOn(Date, 'now').mockReturnValueOnce(expiresAt);
  expect(await counterApprovalHeaders(mutation)).toEqual({});
  activateCounterApprovalSession(enrolled, token);
  clearCounterApprovalSession();
  expect(await counterApprovalHeaders(mutation)).toEqual({});
  activateCounterApprovalSession({ ...enrolled, branchId: 'another' }, token);
  expect(await counterApprovalHeaders(mutation)).toEqual({});
  activateCounterApprovalSession(enrolled, token);
  await unbindCounterBrowser();
  expect(await counterApprovalHeaders(mutation)).toEqual({});
});
