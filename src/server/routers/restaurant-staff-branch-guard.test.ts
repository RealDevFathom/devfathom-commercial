import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./restaurant-staff.ts', import.meta.url), 'utf8');

describe('Restaurant staff branch guard coverage', () => {
  it.each([
    'listBranches',
    'listDirectory',
    'list',
    'create',
    'update',
    'setStatus',
    'listCredentials',
    'issueCredential',
    'rotateCredential',
    'revokeCredential',
    'listStaffJobRoles',
    'setStaffJobRoles',
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
    const next = source.indexOf('\n  ', start + procedure.length + 3);
    expect(source.slice(start, next === -1 ? undefined : next)).toContain(
      'resolveStaffBranchAuthorization'
    );
  });
});
