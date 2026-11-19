// @vitest-environment jsdom
/**
 * DEV-957 phase 1: after enrolment the raw device secret is in no
 * JavaScript-readable storage. The enrolment keeps only a non-extractable
 * signing key in its own store and a key-free mirror in localStorage; every
 * write refuses anything shaped like a secret, and the offline scope document
 * keeps its own forbidden-field guard.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  createMemoryDriver,
  emptyTerminalState,
  writeTerminalState,
} from '@/lib/retail-terminal/local-store';
import { importCounterSigningKey } from './counter-device-signing';
import {
  assertNoDeviceSecret,
  COUNTER_ENROLMENT_MIRROR_KEY,
  enrolledCounterDeviceId,
  forgetCounterEnrolment,
  memoryDeviceKeyBackend,
  readCounterEnrolment,
  readCounterEnrolmentMirror,
  saveCounterEnrolment,
} from './counter-device-store';

const SECRET = `pcd_${'Q'.repeat(20)}${'w'.repeat(23)}`;
const ENROLMENT = {
  organizationId: 'org_store',
  branchId: 'branch_store',
  deviceId: 'device_store',
  name: 'Front counter',
  enrolledAt: '2026-11-19T08:00:00.000Z',
};

afterEach(() => window.localStorage.clear());

function everythingStored(backend: ReturnType<typeof memoryDeviceKeyBackend>): string {
  const local = Object.keys(window.localStorage)
    .map((key) => `${key}=${window.localStorage.getItem(key)}`)
    .join('\n');
  const rows = [...backend.rows.values()].map((row) =>
    JSON.stringify(row, (_key, value) => (value instanceof CryptoKey ? '[CryptoKey]' : value))
  );
  return `${local}\n${rows.join('\n')}`;
}

describe('DEV-957 counter enrolment storage', () => {
  it('keeps a non-extractable key and no secret anywhere readable', async () => {
    const backend = memoryDeviceKeyBackend();
    const signingKey = await importCounterSigningKey(SECRET);
    await saveCounterEnrolment(backend, { ...ENROLMENT, signingKey });

    const stored = await readCounterEnrolment(backend, ENROLMENT.organizationId);
    expect(stored?.deviceId).toBe(ENROLMENT.deviceId);
    expect(stored?.signingKey.extractable).toBe(false);
    expect(everythingStored(backend)).not.toContain(SECRET);
    expect(everythingStored(backend)).not.toMatch(/pcd_/);
    expect(JSON.parse(window.localStorage.getItem(COUNTER_ENROLMENT_MIRROR_KEY)!)).toEqual(
      ENROLMENT
    );
    expect(enrolledCounterDeviceId(ENROLMENT)).toBe(ENROLMENT.deviceId);
    expect(enrolledCounterDeviceId({ ...ENROLMENT, branchId: 'other' })).toBeNull();
    expect(enrolledCounterDeviceId({ ...ENROLMENT, organizationId: 'other' })).toBeNull();
  });

  it('refuses an extractable key and anything carrying a secret', async () => {
    const backend = memoryDeviceKeyBackend();
    const extractable = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      true,
      ['sign']
    );
    await expect(
      saveCounterEnrolment(backend, { ...ENROLMENT, signingKey: extractable })
    ).rejects.toThrow(/extractable/);
    const key = await importCounterSigningKey(SECRET);
    await expect(
      saveCounterEnrolment(backend, { ...ENROLMENT, name: SECRET, signingKey: key })
    ).rejects.toThrow(/device secret/);
    expect(backend.rows.size).toBe(0);
    expect(window.localStorage.getItem(COUNTER_ENROLMENT_MIRROR_KEY)).toBeNull();
    expect(() => assertNoDeviceSecret({ deviceSecret: 'x' })).toThrow(/deviceSecret/);
    expect(() => assertNoDeviceSecret({ nested: [{ value: SECRET }] })).toThrow(/device secret/);
  });

  it('forgets the key and the mirror together', async () => {
    const backend = memoryDeviceKeyBackend();
    await saveCounterEnrolment(backend, {
      ...ENROLMENT,
      signingKey: await importCounterSigningKey(SECRET),
    });
    await forgetCounterEnrolment(backend, ENROLMENT.organizationId);
    expect(await readCounterEnrolment(backend, ENROLMENT.organizationId)).toBeNull();
    expect(readCounterEnrolmentMirror()).toBeNull();
  });

  it('keeps the offline scope document guard: a secret or a session token is never persisted', async () => {
    const driver = createMemoryDriver();
    const state = emptyTerminalState(
      { organizationId: 'o', branchId: 'b', deviceId: 'd' },
      2
    ) as ReturnType<typeof emptyTerminalState> & { queue: unknown };
    await expect(
      writeTerminalState(driver, { ...state, queue: { deviceSecret: SECRET } }, 2)
    ).rejects.toThrow(/forbidden field/i);
    await expect(
      writeTerminalState(driver, { ...state, queue: { sessionToken: 'token' } }, 2)
    ).rejects.toThrow(/forbidden field/i);
  });
});
