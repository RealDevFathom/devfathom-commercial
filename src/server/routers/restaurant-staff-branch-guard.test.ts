import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('src/server/routers/restaurant-staff.ts'), 'utf8');

describe('Restaurant staff branch guard coverage', () => {
  it.each([
    'listBranches',
    'listDirectory',
    'list',
    'create',
    'invite',
    'update',
    'setStatus',
    'listCredentials',
    'issueCredential',
    'rotateCredential',
    'revokeCredential',
    'listStaffJobRoles',
    'setStaffJobRoles',
    'setStaffAccess',
    'provisionMyProfile',
    'listStaffJobRoleAudit',
    'setStaffCapabilityOverride',
    'clearStaffCapabilityOverride',
    'listStaffCapabilityOverrides',
    'listStaffCapabilityAudit',
    'resolveStaffCapabilities',
    'listRoleHolders',
  ])('%s invokes the shared guard', (procedure) => {
    const start = source.search(new RegExp(`^  ${procedure}:`, 'm'));
    expect(start).toBeGreaterThan(-1);
    const remainder = source.slice(start + 1);
    const nextProcedure = remainder.search(/^  [A-Za-z][A-Za-z0-9]*:/m);
    expect(
      source.slice(start, nextProcedure === -1 ? undefined : start + 1 + nextProcedure)
    ).toContain('resolveStaffBranchAuthorization');
  });
});
