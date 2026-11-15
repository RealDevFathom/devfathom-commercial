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
    'listInviteRoles',
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
    const start = source.indexOf(`  ${procedure}:`);
    expect(start).toBeGreaterThan(-1);
    const remainder = source.slice(start + procedure.length + 3);
    const nextProcedure = remainder.search(/\n  [A-Za-z][A-Za-z0-9]*:/);
    expect(
      source.slice(
        start,
        nextProcedure === -1 ? undefined : start + procedure.length + 3 + nextProcedure
      )
    ).toContain('resolveStaffBranchAuthorization');
  });
});
