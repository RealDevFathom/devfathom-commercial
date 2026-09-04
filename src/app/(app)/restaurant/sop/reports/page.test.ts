import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const routePath = 'src/app/(app)/restaurant/sop/reports/page.tsx';

describe('SOP reports heading hierarchy', () => {
  it('starts every top-level report state with an h2 after the page h1', () => {
    const content = readFileSync(routePath, 'utf8');

    expect(content).toContain('<SectionCard title={copy[0]} titleLevel={2}>');
    expect(content).toContain('<SectionCard title="No active branches" titleLevel={2}>');
    expect(content).toContain(
      '<SectionCard title="Report filters" eyebrow="URL-persisted" titleLevel={2}>'
    );
  });
});
