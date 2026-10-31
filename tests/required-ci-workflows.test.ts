import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('required PR validation', () => {
  it.each([
    ['qa.yml', 'automated-gate'],
    ['image-build.yml', 'build'],
  ])('%s cannot skip its required job based on PR metadata', (file, job) => {
    const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');
    const jobBody = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];

    expect(jobBody).toBeDefined();
    expect(jobBody).not.toMatch(/^    if:/m);
    expect(workflow).not.toContain('ci-ready');
    expect(workflow).toMatch(/\bpull_request\b/);
  });

  it('runs QA on PRs targeting every protected branch', () => {
    const workflow = readFileSync('.github/workflows/qa.yml', 'utf8');
    const branches = workflow.split('  pull_request:\n')[1]?.split('  workflow_dispatch:')[0];

    for (const branch of ['develop', 'staging', 'main']) {
      expect(branches).toContain(`      - ${branch}\n`);
    }
  });
});
