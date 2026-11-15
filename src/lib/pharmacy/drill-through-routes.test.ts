import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MODULE_CATALOG } from '@/lib/module-catalog';
import { PHARMACY_METRIC_CONTRACT } from './reports';

/**
 * DEV-509 — every pharmacy dashboard/report drill-through and every pharmacy
 * module route in the commercial catalog must open a page that exists, so an
 * "Open report" or "Drill through" link never dead-ends in a 404.
 */
const APP_ROOT = join(process.cwd(), 'src', 'app', '(app)');

function routeExists(href: string) {
  const pathname = new URL(href, 'https://routes.invalid').pathname;
  const segments = pathname.split('/').filter(Boolean);
  return ['page.tsx', 'page.ts'].some((file) => existsSync(join(APP_ROOT, ...segments, file)));
}

describe('pharmacy link targets resolve to existing routes', () => {
  it.each(
    PHARMACY_METRIC_CONTRACT.filter((metric) => metric.drillThrough).map((metric) => [
      metric.key,
      metric.drillThrough!,
    ])
  )('metric %s drills through to an existing page (%s)', (_key, href) => {
    expect(routeExists(href)).toBe(true);
  });

  it.each(
    MODULE_CATALOG.filter((module) => module.key.startsWith('pharmacy-')).map((module) => [
      module.key,
      module.routePrefix,
    ])
  )('catalog module %s points at an existing page (%s)', (_key, href) => {
    expect(routeExists(href)).toBe(true);
  });

  it('never links to the retired /pharmacy/safety or /pharmacy/procurement paths', () => {
    const hrefs = [
      ...PHARMACY_METRIC_CONTRACT.map((metric) => metric.drillThrough ?? ''),
      ...MODULE_CATALOG.map((module) => module.routePrefix),
    ];
    for (const href of hrefs) {
      expect(href).not.toMatch(/^\/pharmacy\/(safety|procurement)(\/|\?|$)/);
    }
  });
});
