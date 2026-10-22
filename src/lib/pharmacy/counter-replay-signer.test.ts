import { createHmac, webcrypto } from 'node:crypto';

import { expect, it } from 'vitest';

import { canonicalJson } from './offline-snapshot-envelope';
import { createCounterReplaySigner } from './counter-replay-signer';

it('matches the server HMAC canonicalization and supplies ephemeral transport credentials', async () => {
  const scope = { organizationId: 'org-1', branchId: 'branch-1', deviceId: 'device-1' };
  const deviceSecret = `pcd_${'a'.repeat(43)}`;
  const body = { sequence: 1, nested: { z: true, a: 10 } };
  const leasedReceipt = { receiptNumber: 42, leaseId: 'lease-1' };
  const signer = createCounterReplaySigner(
    scope,
    { deviceSecret, terminalSession: 'terminal-session' },
    webcrypto as unknown as Crypto
  );

  const signatures = await signer.sign({ body, leasedReceipt });
  const serverSignature = (payload: unknown) =>
    createHmac('sha256', deviceSecret)
      .update('pharmacy-offline-command:v1\n')
      .update(canonicalJson({ ...scope, payload }))
      .digest('hex');

  expect(signatures).toEqual({
    commandSignature: serverSignature(body),
    receiptSignature: serverSignature(leasedReceipt),
    authorization: `Bearer ${deviceSecret}`,
    terminalSession: 'terminal-session',
  });
  expect(signatures.commandSignature).toMatch(/^[0-9a-f]{64}$/);
  expect(signatures.receiptSignature).toMatch(/^[0-9a-f]{64}$/);
});
