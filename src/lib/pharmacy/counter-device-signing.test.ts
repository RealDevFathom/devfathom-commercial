// @vitest-environment node
/**
 * DEV-957 phase 1: the browser's WebCrypto HMAC must equal the server's
 * `signPharmacyCommand` byte for byte, on fixed vectors, or no offline sale a
 * counter signs could ever replay.
 */
import { describe, expect, it } from 'vitest';

import { signPharmacyCommand } from './sales';
import {
  counterCommandSigningInput,
  counterReplaySigner,
  importCounterSigningKey,
  PHARMACY_COMMAND_SIGNING_DOMAIN,
  signCounterCommand,
} from './counter-device-signing';

const SECRET = 'pcd_A1b2C3d4E5f6G7h8I9j0K-L_mNoPqRsTuVwXyZ01234';
const SCOPE = { organizationId: 'org_vector', branchId: 'branch_vector' };
const DEVICE = 'device_vector';

const COMMAND = {
  sequence: 7,
  idempotencyKey: 'cmd-0007',
  action: 'CASH_OTC_SALE',
  leasedReceipt: {
    leaseId: 'lease_1',
    receiptNumber: 1042,
    originalSaleAt: '2026-11-19T09:15:00.000Z',
    envelope: { kind: 'RULES', version: 3 },
    signature: 'sig',
  },
  snapshots: [],
  lines: [
    {
      medicineId: 'med_1',
      presentationId: 'pres_1',
      packLevelId: 'pack_1',
      saleUnit: 'STRIP',
      quantity: 2,
      canonicalUnitsPerSaleUnit: 10,
      inventoryLotId: 'lot_1',
      stockLocationId: 'loc_1',
    },
  ],
  amountMinor: 12_345,
  cashReceivedMinor: 20_000,
  note: 'Urdu دوا and emoji-free unicode ✓',
};

describe('DEV-957 browser command signing', () => {
  it('matches signPharmacyCommand on fixed vectors, for the command and its leased receipt', async () => {
    expect(SECRET).toMatch(/^pcd_[A-Za-z0-9_-]{43}$/);
    const key = await importCounterSigningKey(SECRET);
    for (const payload of [COMMAND, COMMAND.leasedReceipt, {}, [], 'text', 0]) {
      expect(await signCounterCommand(key, SCOPE, DEVICE, payload)).toBe(
        signPharmacyCommand(SCOPE, DEVICE, payload, SECRET)
      );
    }
    const signatures = await counterReplaySigner(key, SCOPE, DEVICE)(
      COMMAND as unknown as Record<string, unknown>,
      COMMAND.leasedReceipt as unknown as Record<string, unknown>
    );
    expect(signatures).toEqual({
      command: signPharmacyCommand(SCOPE, DEVICE, COMMAND, SECRET),
      receipt: signPharmacyCommand(SCOPE, DEVICE, COMMAND.leasedReceipt, SECRET),
    });
  });

  it('pins one vector so a change to either side is caught', async () => {
    const key = await importCounterSigningKey(SECRET);
    const pinned = signPharmacyCommand(SCOPE, DEVICE, { amountMinor: 100 }, SECRET);
    expect(pinned).toMatch(/^[0-9a-f]{64}$/);
    expect(await signCounterCommand(key, SCOPE, DEVICE, { amountMinor: 100 })).toBe(pinned);
    expect(new TextDecoder().decode(counterCommandSigningInput(SCOPE, DEVICE, { b: 1, a: 2 }))).toBe(
      `${PHARMACY_COMMAND_SIGNING_DOMAIN}{"branchId":"branch_vector","deviceId":"device_vector","organizationId":"org_vector","payload":{"a":2,"b":1}}`
    );
  });

  it('differs for another device, branch, payload or secret', async () => {
    const key = await importCounterSigningKey(SECRET);
    const base = await signCounterCommand(key, SCOPE, DEVICE, COMMAND);
    expect(await signCounterCommand(key, SCOPE, 'device_other', COMMAND)).not.toBe(base);
    expect(
      await signCounterCommand(key, { ...SCOPE, branchId: 'branch_other' }, DEVICE, COMMAND)
    ).not.toBe(base);
    expect(
      await signCounterCommand(key, SCOPE, DEVICE, { ...COMMAND, amountMinor: 12_346 })
    ).not.toBe(base);
    const other = await importCounterSigningKey(`pcd_${'z'.repeat(43)}`);
    expect(await signCounterCommand(other, SCOPE, DEVICE, COMMAND)).not.toBe(base);
  });

  it('keeps the secret inside a key that cannot be exported', async () => {
    const key = await importCounterSigningKey(SECRET);
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['sign']);
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('refuses anything that is not a counter credential', async () => {
    await expect(importCounterSigningKey('pcd_short')).rejects.toThrow(/not a pharmacy counter/);
    await expect(importCounterSigningKey(`prd_${'a'.repeat(43)}`)).rejects.toThrow();
  });
});
