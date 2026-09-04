import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const routeDirectory = 'src/app/(app)/restaurant/sop/reports';

describe('SOP reports route shell', () => {
  it('keeps request-bound report dependencies behind the local Suspense boundary', () => {
    const entry = readFileSync(`${routeDirectory}/page.tsx`, 'utf8');
    const content = readFileSync(`${routeDirectory}/report-content.tsx`, 'utf8');

    expect(entry).toContain("import { Suspense } from 'react'");
    expect(entry).toContain("await import('./report-content')");
    expect(entry).toContain('fallback={<Loading />}');
    expect(entry).not.toContain("from '@/server/trpc'");
    expect(entry).not.toContain("from '@/server/routers/restaurant-sop-execution'");
    expect(entry).not.toContain('await searchParams');

    expect(content).toContain("from '@/server/trpc'");
    expect(content).toContain("from '@/server/routers/restaurant-sop-execution'");
    expect(content).toContain('const query = await searchParams');
  });
});
