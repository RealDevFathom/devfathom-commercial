import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * DEV-961: every staff or role change in `restaurantStaff` that could leave a staff profile able
 * to approve without a login runs under the terminal-only approver guard (`guarded`), so only
 * the owner can make it (behaviour: `tests/terminal-only-approver-owner.db.test.ts`). A new
 * mutation must either use the guard or be listed here with the reason it cannot.
 */
const UNGUARDED: Record<string, string> = {
  provisionMyProfile: 'creates the caller’s own profile, linked to their login',
  invite: 'creates a profile linked to a new login',
  createJobRole: 'a new role has no holders',
  issueCredential: 'a PIN gives no approver right',
  rotateCredential: 'a PIN gives no approver right',
  revokeCredential: 'a PIN gives no approver right',
};

const source = readFileSync(join(__dirname, 'restaurant-staff.ts'), 'utf8');

function procedures(): { name: string; builder: string; body: string }[] {
  const starts = [...source.matchAll(/\n  (\w+): (\w+Procedure)\b/g)];
  return starts.map((match, index) => ({
    name: match[1]!,
    builder: match[2]!,
    body: source.slice(match.index!, starts[index + 1]?.index ?? source.length),
  }));
}

describe('DEV-961 restaurantStaff changes are guarded for terminal-only approvers', () => {
  it('runs every staff and role mutation under the guard, or lists why not', () => {
    // Self-service mutations have a separate inventory below. Each body ends at the
    // next procedure declaration, whichever procedure builder that declaration uses.
    const mutations = procedures().filter(
      (procedure) =>
        procedure.builder !== 'protectedProcedure' && procedure.body.includes('.mutation(')
    );
    expect(mutations.length).toBeGreaterThan(10);
    const unguarded = mutations
      .filter((procedure) => !/\bguarded\(ctx, 'restaurantStaff\.\w+'/.test(procedure.body))
      .map((procedure) => procedure.name)
      .filter((name) => !UNGUARDED[name]);
    expect(unguarded).toEqual([]);
  });

  it('classifies credential listing as a branch-scoped staff query', () => {
    const listing = procedures().find(({ name }) => name === 'listCredentials')!;
    expect(listing.builder).toBe('staffProcedure');
    expect(listing.body).toContain('.query(');
    expect(listing.body).not.toContain('.mutation(');
    expect(listing.body).toContain('assertAuthorizedStaffProfile(');
    expect(listing.body).toContain('restaurantOperatorCredential.findMany(');
  });

  it('limits self-service mutations to revoking the caller’s own terminal credential', () => {
    const selfService = procedures().filter(
      ({ builder, body }) => builder === 'protectedProcedure' && body.includes('.mutation(')
    );
    expect(selfService.map(({ name }) => name)).toEqual(['revokeMyTerminalCredential']);
    const [{ body }] = selfService;
    expect(body).toContain('staffProfile: { userId: ctx.session!.user.id }');
    expect(body).toContain('selfOnly: true');
    expect(body).toContain("operation: 'revoke'");
    expect(body).toContain('revokeOperatorCredential(db, input)');
  });

  it('refuses a manager removing a login before the write', () => {
    const update = procedures().find((procedure) => procedure.name === 'update')!;
    expect(update.body).toMatch(/if \(patch\.userId === null\)\s+await assertMayRemoveLogin\(/);
  });
});
