import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('restaurant staff invitation handoff', () => {
  it('offers a direct Team invitation path and explains the role-assignment return step', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/components/restaurant/restaurant-staff-console.tsx'),
      'utf8'
    );

    expect(source).toContain('href="/team?invite=1"');
    expect(source).toContain('Invite a new team member');
    expect(source).toContain('choose their Restaurant staff role');
    expect(source).toContain('After they accept, return here');
  });
});
