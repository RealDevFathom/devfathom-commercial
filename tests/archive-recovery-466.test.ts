import { readFile } from 'node:fs/promises';

const dispositionUrl = new URL(
  '../docs/archive-recovery/issue-466-growth-g2-followups.md',
  import.meta.url
);

const archivedCommits = [
  '93e27ae3',
  '58eb10e8',
  'b0e6fe9c',
  '3e3851a5',
  '304a4aa6',
  'f6463f25',
  '1378c79e',
  '6e152825',
  '25834be5',
  '646692de',
  'dcbd97cc',
  '67df65b5',
  '97e9d2c4',
  'ecfc2f76',
  'd3e8cdad',
  '7b81f39e',
] as const;

describe('issue #466 archive recovery disposition', () => {
  it('records one unambiguous decision for the preserved archive', async () => {
    const disposition = await readFile(dispositionUrl, 'utf8');

    expect(disposition).toContain('archive/fix/growth-g2-followups');
    expect(disposition).toContain('close the archived branch as obsolete');
    expect(disposition).toContain('Do not restore `fix/growth-g2-followups` as a branch.');
    expect(disposition).toContain('Do not open a PR from the archived tree.');
    expect(disposition).toContain('Do not cherry-pick any of the 16 commits');
  });

  it.each(archivedCommits)('accounts for archived commit %s', async (commit) => {
    const disposition = await readFile(dispositionUrl, 'utf8');

    expect(disposition).toContain(`\`${commit}\``);
  });
});
