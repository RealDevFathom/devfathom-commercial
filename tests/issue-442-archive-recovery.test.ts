import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('issue 442 archive recovery', () => {
  it('keeps the horizontally scrolling regulatory history keyboard reachable', () => {
    const source = read('src/components/pharmacy/regulatory-profile-form.tsx');

    expect(source).toContain('aria-label="Regulatory profile version history"');
    expect(source).toMatch(
      /aria-label="Regulatory profile version history"[\s\S]*role="region"[\s\S]*tabIndex=\{0\}/
    );
  });

  it('uses body contrast for the neutral status pill rather than muted text', () => {
    const source = read('src/components/ui/status-pill.tsx');

    expect(source).toContain("neutral: 'bg-muted text-text-body'");
    expect(source).not.toContain("neutral: 'bg-muted text-text-muted'");
  });
});
