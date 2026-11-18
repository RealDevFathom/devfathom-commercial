import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

/**
 * DEV-857. `next dev` rewrites the block between the `nextjs-agent-rules`
 * markers in AGENTS.md whenever it differs from what the installed Next.js
 * would write, which leaves an uncommitted change in every checkout. The
 * committed block must therefore be exactly the installed version's block.
 * After a Next.js upgrade changes it, run `next dev` once (or call
 * `writeAgentFiles`) and commit AGENTS.md.
 */
describe('AGENTS.md Next.js managed block (DEV-857)', () => {
  it('matches what the installed Next.js writes, so the dev server leaves it alone', () => {
    const agentFiles = require('next/dist/server/lib/generate-agent-files.js') as {
      hasCurrentAgentRules: (dir: string) => boolean;
    };
    expect(agentFiles.hasCurrentAgentRules(resolve(__dirname, '..'))).toBe(true);
  });
});
