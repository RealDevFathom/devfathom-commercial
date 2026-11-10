// @vitest-environment node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Recovery = {
  commits: Array<{ sha: string; disposition: string; evidence: string[] }>;
};

const root = resolve(import.meta.dirname, '..');
const recovery = JSON.parse(
  readFileSync(resolve(root, 'docs/archive-recovery/issue-504.json'), 'utf8')
) as Recovery;

describe('WHA-66 archive recovery decision', () => {
  it('records the obsolete archive and its superseded PR mapping', () => {
    expect(recovery).toMatchObject({
      issue: 504,
      linearIssue: 'DEV-214',
      archive: 'archive/wip/WHA-66-dirty',
      tip: 'ff3bdd153ad614b949919d89618b510f5d11b122',
      decision: 'obsolete',
      supersedes: [272],
      rationale: expect.stringMatching(/\S/),
      supersededPrContext: expect.stringMatching(/unrelated/),
    });
    expect(recovery.commits).toHaveLength(1);
    expect(recovery.commits[0]).toMatchObject({
      sha: 'ff3bdd153ad614b949919d89618b510f5d11b122',
      disposition: 'obsolete',
    });
  });

  it('retains replacement evidence for the archived snapshot', () => {
    for (const commit of recovery.commits) {
      expect(commit.evidence.length, commit.sha).toBeGreaterThan(0);
      for (const path of commit.evidence) {
        expect(existsSync(resolve(root, path)), `${commit.sha}: ${path}`).toBe(true);
      }
    }
  });
});
