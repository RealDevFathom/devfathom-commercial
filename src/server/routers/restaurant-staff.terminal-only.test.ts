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

function procedures(): { name: string; body: string }[] {
  const starts = [...source.matchAll(/\n  (\w+): staffProcedure/g)];
  return starts.map((match, index) => ({
    name: match[1]!,
    body: source.slice(match.index!, starts[index + 1]?.index ?? source.length),
  }));
}

describe('DEV-961 restaurantStaff changes are guarded for terminal-only approvers', () => {
  it('runs every staff and role mutation under the guard, or lists why not', () => {
    const mutations = procedures().filter((procedure) => procedure.body.includes('.mutation('));
    expect(mutations.length).toBeGreaterThan(10);
    const unguarded = mutations
      .filter((procedure) => !/\bguarded\(ctx, 'restaurantStaff\.\w+'/.test(procedure.body))
      .map((procedure) => procedure.name)
      .filter((name) => !UNGUARDED[name]);
    expect(unguarded).toEqual([]);
  });

  it('refuses a manager removing a login before the write', () => {
    const update = procedures().find((procedure) => procedure.name === 'update')!;
    expect(update.body).toMatch(/if \(patch\.userId === null\)\s+await assertMayRemoveLogin\(/);
  });
});
