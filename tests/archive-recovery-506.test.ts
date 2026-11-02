// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const dispositionUrl = new URL(
  '../docs/archive-recovery/issue-506-white-ui-dirty.md',
  import.meta.url
);

describe('issue #506 archive recovery disposition', () => {
  it('records one unambiguous decision for the preserved archive', async () => {
    const disposition = await readFile(dispositionUrl, 'utf8');

    expect(disposition).toContain('archive/wip/white-ui-dirty-20260828');
    expect(disposition).toContain('close the archived branch as obsolete');
    expect(disposition).toContain('Do not restore `wip/white-ui-dirty-20260828` as a branch.');
    expect(disposition).toContain('Do not open a PR from the archived tree.');
    expect(disposition).toContain('Do not cherry-pick any of the three commits');
  });

  it.each(['c85ea42a', '43a72f44', 'f6f72ee0'])(
    'accounts for archived commit %s with a disposition',
    async (commit) => {
      const disposition = await readFile(dispositionUrl, 'utf8');

      expect(disposition).toContain(`| \`${commit}\` |`);
    }
  );

  it('documents the maintained shell, design system, and runtime replacements', async () => {
    const disposition = await readFile(dispositionUrl, 'utf8');

    expect(disposition).toContain('Next.js and React');
    expect(disposition).toContain('src/components/layout/app-shell.tsx');
    expect(disposition).toContain('src/app/globals.css');
    expect(disposition).toContain('docs/design-system/DEVFATHOM-STUDIO.md');
    expect(disposition).toContain('src/app/api/trpc/[trpc]/route.ts');
    expect(disposition).toContain('supersede the archived Nuxt shell and FastAPI migration');
    expect(disposition).toContain('its preserved tree is identical to its parent `43a72f44`');
  });
});
