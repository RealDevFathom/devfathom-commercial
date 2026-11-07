import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGroups,
  maskAddress,
  maskId,
  parseArgs,
} from '../scripts/report-global-email-collisions';

describe('report-global-email-collisions masking', () => {
  it('masks the local part and keeps the domain', () => {
    expect(maskAddress('alice@example.com')).toBe('a****@example.com');
    expect(maskAddress('a@example.com')).toBe('a*@example.com');
    expect(maskAddress('not-an-address')).toBe('***');
  });

  it('truncates ids', () => {
    expect(maskId('0123456789abcdef')).toBe('01234567…');
  });

  it('masks by default and only reveals on explicit opt-in', () => {
    expect(parseArgs([]).reveal).toBe(false);
    expect(parseArgs(['--json', '--summary']).reveal).toBe(false);
    expect(parseArgs(['--unmasked']).reveal).toBe(true);
    expect(parseArgs(['--reveal']).reveal).toBe(true);
  });
});

describe('report-global-email-collisions credential counts', () => {
  const account = (accountId: string, organizationId: string, hasCredential: boolean) => ({
    accountId,
    organizationId,
    organizationSlug: null,
    organizationStatus: 'ACTIVE',
    normalized: 'shared@example.com',
    storedEmail: 'shared@example.com',
    status: 'ACTIVE',
    hasCredential,
    mfaEnabled: false,
    createdOn: '2026-01-01',
    orgHasActiveConnection: false,
    orgEnforcesSso: false,
    scimManaged: false,
  });

  it('counts accounts with and without a credential under non-secret names', () => {
    const [group] = buildGroups(
      [account('a1', 'o1', true), account('a2', 'o2', false), account('a3', 'o3', false)],
      []
    );
    expect(group).toBeDefined();
    expect(group!.credentialSet).toBe(1);
    expect(group!.credentialless).toBe(2);
    expect(Object.keys(group!).some((key) => /password/i.test(key))).toBe(false);
  });

  it('never logs a value through a password-named identifier (code-scanning #6/#7)', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../scripts/report-global-email-collisions.ts'),
      'utf8'
    );
    // The only permitted mention is the SQL column read, which is reduced to a boolean.
    const identifiers = source.match(/\b\w*password\w*\b/gi) ?? [];
    expect(identifiers.filter((word) => word !== 'password')).toEqual([]);
  });
});
