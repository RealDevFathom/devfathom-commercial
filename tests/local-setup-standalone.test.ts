// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('documents a fresh standalone build before production startup', () => {
  const setup = readFileSync(resolve('docs/LOCAL_SETUP.md'), 'utf8');
  const startup = setup.split('## 4. Start the project')[1].split('## 5. Verify the setup')[0];

  expect(startup).toMatch(/`bun run build`[\s\S]*before `bun start`/);
  expect(startup).toContain('current checkout');
  expect(startup).toContain('`.next/standalone/server.js`');
  expect(startup).toContain('`public` and `.next/static`');
  expect(startup).toContain('stale output');
});
