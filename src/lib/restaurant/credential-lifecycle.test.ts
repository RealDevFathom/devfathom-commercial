import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CredentialLifecycleError,
  issueOperatorCredential,
  revokeOperatorCredential,
  rotateOperatorCredential,
} from './credential-lifecycle';
import { CredentialPolicyError, verifyOperatorCredential } from './operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  staffFindUnique: vi.fn(),
  credFindFirst: vi.fn(),
  credFindUnique: vi.fn(),
  credCreate: vi.fn(),
  credUpdate: vi.fn(),
}));

const db = {
  restaurantStaffProfile: { findUnique: mocks.staffFindUnique },
  restaurantOperatorCredential: {
    findFirst: mocks.credFindFirst,
    findUnique: mocks.credFindUnique,
    create: mocks.credCreate,
    update: mocks.credUpdate,
  },
} as unknown as ScopedDb;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', status: 'ACTIVE' });
  mocks.credFindFirst.mockResolvedValue(null);
  mocks.credCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'cred_new',
    ...data,
  }));
  mocks.credUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      ...data,
    })
  );
});

describe('issueOperatorCredential', () => {
  it('hashes the secret via the L1 primitive and stores only the hash', async () => {
    await issueOperatorCredential(db, { staffProfileId: 'staff_1', type: 'PIN', secret: '4821' });

    expect(mocks.credCreate).toHaveBeenCalledTimes(1);
    const { data } = mocks.credCreate.mock.calls[0][0];
    // Never the plaintext; a real, verifiable bcrypt hash; clean counters.
    expect(data.credentialHash).not.toBe('4821');
    expect(await verifyOperatorCredential('PIN', '4821', data.credentialHash)).toBe(true);
    expect(data.failedAttempts).toBe(0);
    expect(data.lockedUntil).toBeNull();
    expect(data.revokedAt).toBeNull();
    expect(data.staffProfileId).toBe('staff_1');
    expect(data.deviceId).toBeNull();
  });

  it('scopes a credential to a device when deviceId is given', async () => {
    await issueOperatorCredential(db, {
      staffProfileId: 'staff_1',
      type: 'BADGE',
      secret: 'BADGE-SECRET-01',
      deviceId: 'device_1',
    });
    expect(mocks.credFindFirst).toHaveBeenCalledWith({
      where: { staffProfileId: 'staff_1', type: 'BADGE', deviceId: 'device_1', revokedAt: null },
      select: { id: true },
    });
    expect(mocks.credCreate.mock.calls[0][0].data.deviceId).toBe('device_1');
  });

  it('rejects issuing to a missing staff profile', async () => {
    mocks.staffFindUnique.mockResolvedValue(null);
    await expect(
      issueOperatorCredential(db, { staffProfileId: 'gone', type: 'PIN', secret: '4821' })
    ).rejects.toMatchObject({ reason: 'STAFF_NOT_FOUND' });
    expect(mocks.credCreate).not.toHaveBeenCalled();
  });

  it('refuses to issue to an archived operator', async () => {
    mocks.staffFindUnique.mockResolvedValue({ id: 'staff_1', status: 'ARCHIVED' });
    await expect(
      issueOperatorCredential(db, { staffProfileId: 'staff_1', type: 'PIN', secret: '4821' })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    expect(mocks.credCreate).not.toHaveBeenCalled();
  });

  it('refuses a second active credential of the same (type, device) scope', async () => {
    mocks.credFindFirst.mockResolvedValue({ id: 'cred_existing' });
    await expect(
      issueOperatorCredential(db, { staffProfileId: 'staff_1', type: 'PIN', secret: '4821' })
    ).rejects.toMatchObject({ reason: 'ALREADY_EXISTS' });
    expect(mocks.credCreate).not.toHaveBeenCalled();
  });

  it('propagates the L1 policy floor for a weak secret (no reimplementation here)', async () => {
    await expect(
      issueOperatorCredential(db, { staffProfileId: 'staff_1', type: 'PIN', secret: '12' })
    ).rejects.toBeInstanceOf(CredentialPolicyError);
    expect(mocks.credCreate).not.toHaveBeenCalled();
  });
});

describe('rotateOperatorCredential', () => {
  it('writes a new hash and resets the lockout counters', async () => {
    mocks.credFindUnique.mockResolvedValue({ id: 'cred_1', type: 'PIN', revokedAt: null });
    await rotateOperatorCredential(db, { credentialId: 'cred_1', secret: '99887' });

    const { where, data } = mocks.credUpdate.mock.calls[0][0];
    expect(where).toEqual({ id: 'cred_1' });
    expect(await verifyOperatorCredential('PIN', '99887', data.credentialHash)).toBe(true);
    expect(data.failedAttempts).toBe(0);
    expect(data.lockedUntil).toBeNull();
  });

  it('rejects rotating a missing credential', async () => {
    mocks.credFindUnique.mockResolvedValue(null);
    await expect(
      rotateOperatorCredential(db, { credentialId: 'gone', secret: '99887' })
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(mocks.credUpdate).not.toHaveBeenCalled();
  });

  it('rejects rotating an already-revoked credential', async () => {
    mocks.credFindUnique.mockResolvedValue({
      id: 'cred_1',
      type: 'PIN',
      revokedAt: new Date('2026-08-18T00:00:00Z'),
    });
    await expect(
      rotateOperatorCredential(db, { credentialId: 'cred_1', secret: '99887' })
    ).rejects.toMatchObject({ reason: 'REVOKED' });
    expect(mocks.credUpdate).not.toHaveBeenCalled();
  });
});

describe('revokeOperatorCredential', () => {
  it('stamps revokedAt with the supplied server timestamp (immediate)', async () => {
    const now = new Date('2026-08-18T12:00:00.000Z');
    mocks.credFindUnique.mockResolvedValue({ id: 'cred_1', type: 'PIN', revokedAt: null });
    await revokeOperatorCredential(db, { credentialId: 'cred_1', now });
    expect(mocks.credUpdate).toHaveBeenCalledWith({
      where: { id: 'cred_1' },
      data: { revokedAt: now },
    });
  });

  it('is idempotent — re-revoking returns the existing row without a second write', async () => {
    const revokedAt = new Date('2026-08-01T00:00:00.000Z');
    mocks.credFindUnique.mockResolvedValue({ id: 'cred_1', type: 'PIN', revokedAt });
    const result = await revokeOperatorCredential(db, { credentialId: 'cred_1' });
    expect(result).toMatchObject({ revokedAt });
    expect(mocks.credUpdate).not.toHaveBeenCalled();
  });

  it('rejects revoking a missing credential', async () => {
    mocks.credFindUnique.mockResolvedValue(null);
    await expect(revokeOperatorCredential(db, { credentialId: 'gone' })).rejects.toBeInstanceOf(
      CredentialLifecycleError
    );
    expect(mocks.credUpdate).not.toHaveBeenCalled();
  });
});

describe('approval PIN provenance on issue and rotation', () => {
  it.each([
    { type: 'PIN', deviceId: null, memberSelectedApprovalPin: undefined, expected: true },
    { type: 'PIN', deviceId: null, memberSelectedApprovalPin: true, expected: false },
    { type: 'PIN', deviceId: 'register', memberSelectedApprovalPin: undefined, expected: false },
    { type: 'BADGE', deviceId: null, memberSelectedApprovalPin: undefined, expected: false },
  ] as const)(
    'persists the required change flag for $type / $deviceId / member-selected $memberSelectedApprovalPin',
    async ({ type, deviceId, memberSelectedApprovalPin, expected }) => {
      const secret = type === 'BADGE' ? 'fixture-badge-42' : '48619';
      const staffProfileId = 'staff_1';
      await issueOperatorCredential(db, {
        staffProfileId,
        type,
        deviceId,
        memberSelectedApprovalPin,
        secret,
      });
      expect(mocks.credCreate.mock.calls[0][0].data.approvalPinMustChange).toBe(expected);

      mocks.credFindUnique.mockResolvedValue({ id: 'cred_1', type, deviceId, revokedAt: null });
      await rotateOperatorCredential(db, {
        credentialId: 'cred_1',
        memberSelectedApprovalPin,
        secret,
      });
      expect(mocks.credUpdate.mock.calls[0][0].data.approvalPinMustChange).toBe(expected);
    }
  );
});
