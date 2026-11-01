import { expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { lockCustomerConsent, writePatientConsent } from './consent-writer';

it('locks patient before customer and never locks another tenant implicitly', async () => {
  const query = vi.fn().mockResolvedValue([{ id: 'p', patientId: 'p' }]);
  const db = {
    $queryRaw: query,
    pharmacyCustomer: { findFirst: vi.fn().mockResolvedValue({ patientId: 'p' }) },
  } as unknown as ScopedDb;
  await lockCustomerConsent(db, 'org-a', 'customer-a');
  expect(query.mock.calls[0][0].sql).toContain('pharmacy_patients');
  expect(query.mock.calls[0][0].values).toEqual(['org-a', 'p']);
  expect(query.mock.calls[1][0].sql).toContain('pharmacy_customers');
});
it('assigns server versions and supersession after the shared lock', async () => {
  const order: string[] = [];
  const create = vi.fn(async ({ data }) => data);
  const db = {
    $queryRaw: vi.fn(async () => {
      order.push('lock');
      return [{ id: 'p', patientId: 'p' }];
    }),
    patientConsent: {
      findFirst: vi.fn(async () => {
        order.push('latest');
        return { id: 'old', version: 8 };
      }),
      create,
    },
  } as unknown as ScopedDb;
  const input = {
    patientId: 'p',
    purpose: 'MARKETING' as const,
    channel: 'WHATSAPP' as const,
    granted: false,
    version: 99,
    supersedesId: 'untrusted',
  };
  const now = new Date('2026-10-06');
  expect(await writePatientConsent(db, 'org-a', 'actor', input, now)).toMatchObject({
    version: 9,
    supersedesId: 'old',
    revokedAt: now,
    recordedAt: now,
    source: 'COUNTER_TABLET',
    staffId: 'actor',
  });
  expect(order).toEqual(['lock', 'latest']);
});
it('does not write when patient is outside the tenant', async () => {
  const db = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as ScopedDb;
  await expect(
    writePatientConsent(db, 'org-a', 'actor', {
      patientId: 'p',
      purpose: 'MARKETING',
      channel: 'WHATSAPP',
      granted: true,
    })
  ).rejects.toThrow('unavailable');
});

it('fails closed if customer identity changes while acquiring the locks', async () => {
  const db = {
    pharmacyCustomer: { findFirst: vi.fn().mockResolvedValue({ patientId: 'old-patient' }) },
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: 'old-patient' }])
      .mockResolvedValueOnce([{ patientId: 'new-patient' }]),
  } as unknown as ScopedDb;
  await expect(lockCustomerConsent(db, 'org-a', 'customer')).rejects.toThrow('identity changed');
});

it('records self-service provenance without inventing a staff member', async () => {
  const create = vi.fn(async ({ data }) => data);
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'p' }]),
    patientConsent: { findFirst: vi.fn().mockResolvedValue(null), create },
  } as unknown as ScopedDb;
  await writePatientConsent(db, 'org-a', 'customer-a', {
    patientId: 'p',
    purpose: 'MARKETING',
    channel: 'WHATSAPP',
    granted: true,
    source: 'QR',
  });
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({ source: 'QR', staffId: null }),
  });
});
