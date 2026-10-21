/**
 * D19 — an anonymous, token-bearing request resolves its tenant from the token,
 * because both token hashes are globally unique. A caller without a valid token
 * resolves to nothing, so this opens no new surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  invitationFindUnique: vi.fn(),
  resetFindUnique: vi.fn(),
  occurrenceFindUnique: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) =>
    run({
      invitation: { findUnique: mocks.invitationFindUnique },
      passwordResetToken: { findUnique: mocks.resetFindUnique },
      meetingOccurrence: { findUnique: mocks.occurrenceFindUnique },
    })
  ),
}));

import { organizationForAnonymousToken, organizationForMeetingPublicId } from './anonymous-tenant';

const TOKEN = 'a'.repeat(43);
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

describe('organizationForAnonymousToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invitationFindUnique.mockResolvedValue(null);
    mocks.resetFindUnique.mockResolvedValue(null);
  });

  it('resolves an invitation token to its organization', async () => {
    mocks.invitationFindUnique.mockResolvedValue({ organizationId: 'org_1' });

    await expect(organizationForAnonymousToken(TOKEN)).resolves.toBe('org_1');
    expect(mocks.invitationFindUnique).toHaveBeenCalledWith({
      where: { tokenHash: TOKEN_HASH },
      select: { organizationId: true },
    });
  });

  it('resolves a password-reset token to its organization', async () => {
    mocks.resetFindUnique.mockResolvedValue({ organizationId: 'org_2' });

    await expect(organizationForAnonymousToken(TOKEN)).resolves.toBe('org_2');
  });

  it('looks up only by the token hash, never by anything caller-supplied', async () => {
    await organizationForAnonymousToken(TOKEN);

    for (const call of [
      ...mocks.invitationFindUnique.mock.calls,
      ...mocks.resetFindUnique.mock.calls,
    ]) {
      const [args] = call as [{ where: Record<string, unknown>; select: Record<string, unknown> }];
      expect(Object.keys(args.where)).toEqual(['tokenHash']);
      expect(args.select).toEqual({ organizationId: true });
    }
  });

  it('resolves nothing for an unknown token', async () => {
    await expect(organizationForAnonymousToken(TOKEN)).resolves.toBeNull();
  });

  it.each([[null], [undefined], [''], ['short'], ['x'.repeat(600)]])(
    'refuses the malformed token %j without querying',
    async (token) => {
      await expect(organizationForAnonymousToken(token)).resolves.toBeNull();
      expect(mocks.invitationFindUnique).not.toHaveBeenCalled();
      expect(mocks.resetFindUnique).not.toHaveBeenCalled();
    }
  );
});

/**
 * D2/D4 — `MeetingOccurrence.publicId` is the third anonymous tenant-resolution
 * key, and must reproduce the properties that made the token resolver above
 * acceptable: bounded input, one predicate the caller must hold, and only an
 * organization id returned.
 */
describe('organizationForMeetingPublicId', () => {
  const PUBLIC_ID = '7e3c19c6-79a4-4db1-a436-68efbf00f309';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.occurrenceFindUnique.mockResolvedValue(null);
  });

  it('resolves a public id to its organization', async () => {
    mocks.occurrenceFindUnique.mockResolvedValue({ organizationId: 'org_1' });

    await expect(organizationForMeetingPublicId(PUBLIC_ID)).resolves.toBe('org_1');
    expect(mocks.occurrenceFindUnique).toHaveBeenCalledWith({
      where: { publicId: PUBLIC_ID },
      select: { organizationId: true },
    });
  });

  it('returns only an organization id, never occurrence data', async () => {
    mocks.occurrenceFindUnique.mockResolvedValue({ organizationId: 'org_1' });

    await organizationForMeetingPublicId(PUBLIC_ID);

    const [args] = mocks.occurrenceFindUnique.mock.calls[0] as [
      { where: Record<string, unknown>; select: Record<string, unknown> },
    ];
    expect(Object.keys(args.where)).toEqual(['publicId']);
    expect(args.select).toEqual({ organizationId: true });
  });

  it('resolves nothing for an unknown public id', async () => {
    await expect(organizationForMeetingPublicId(PUBLIC_ID)).resolves.toBeNull();
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['short'],
    ['not-a-uuid-at-all'],
    // A v1 UUID: the column is defaulted to gen_random_uuid(), which is v4.
    ['7e3c19c6-79a4-1db1-a436-68efbf00f309'],
    // SQL-ish and wildcard payloads must not reach the query.
    ["' OR 1=1 --"],
    ['%'],
    ['x'.repeat(600)],
  ])('refuses the malformed public id %j without querying', async (value) => {
    await expect(organizationForMeetingPublicId(value)).resolves.toBeNull();
    expect(mocks.occurrenceFindUnique).not.toHaveBeenCalled();
  });
});
