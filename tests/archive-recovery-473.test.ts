// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('DEV-230 archive recovery disposition', () => {
  it('records the obsolete archive without restoring its branch or commit', async () => {
    const disposition = await readFile(
      new URL('../docs/archive-recovery/issue-473-sec-next-upgrade.md', import.meta.url),
      'utf8'
    );

    expect(disposition).toContain('close the archived branch as obsolete');
    expect(disposition).toContain('Do not restore `fix/sec-next-upgrade` as a branch.');
    expect(disposition).toContain('Do not open a PR from `archive/fix/sec-next-upgrade`.');
    expect(disposition).toContain('Do not cherry-pick `bc7a1683`.');
  });

  it('keeps Undici overrides scoped to consumers and their distinct major versions', async () => {
    const { overrides } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    );

    expect(overrides).not.toHaveProperty('undici');
    expect(overrides['@ai-sdk/provider-utils@^4']).toEqual({ '.': '4.0.62', undici: '6.29.1' });
    expect(overrides['@vercel/blob']).toEqual({ undici: '6.29.1' });
    expect(overrides['@dotenvx/dotenvx']).toEqual({ undici: '7.30.1' });
    expect(overrides.shadcn).toEqual({ undici: '7.30.1' });
    expect(overrides.jsdom).toEqual({ undici: '8.12.3' });
  });
});
