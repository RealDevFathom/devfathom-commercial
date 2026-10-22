import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

const threePixelSemanticRing =
  /focus-visible:(?:border-ring[^'"\n]*focus-visible:ring-3[^'"\n]*focus-visible:ring-ring|outline-none[^'"\n]*focus-visible:ring-3[^'"\n]*focus-visible:ring-ring)/;

describe('issue #76 visible-focus contract', () => {
  it.each([
    'src/components/ui/button.tsx',
    'src/components/ui/input.tsx',
    'src/components/restaurant/catalog/catalog-console.tsx',
    'src/components/restaurant/menus/menus-console.tsx',
    'src/components/restaurant/menu-import/menu-import-console.tsx',
    'src/components/restaurant/pos/order-pad.tsx',
    'src/components/restaurant/kds/kds-board.tsx',
    'src/components/restaurant/restaurant-camera-wizard.tsx',
    'src/components/terminal/terminal-console.tsx',
  ])('%s keeps a three-pixel semantic keyboard-focus ring', (path) => {
    expect(source(path)).toMatch(threePixelSemanticRing);
  });

  it('keeps tenant and platform navigation keyboard focus visible', () => {
    expect(source('src/components/layout/sidebar.tsx')).toContain(
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
    );

    const platformShell = source('src/components/platform/platform-shell.tsx');
    expect(platformShell).toContain('platform-workspace');
    expect(platformShell.match(/focus-visible:ring-2 focus-visible:ring-ring/g)).toHaveLength(2);
  });

  it('applies a visible fallback to every platform console route', () => {
    expect(source('src/app/platform/(console)/layout.tsx')).toContain('<PlatformShell');

    const styles = source('src/app/globals.css');
    expect(styles).toMatch(
      /\.platform-workspace :is\(input, select, textarea\):focus[\s\S]*?box-shadow: 0 0 0 3px/
    );
    expect(styles).toMatch(
      /\.platform-workspace button:focus-visible,[\s\S]*?\.platform-workspace a:focus-visible,[\s\S]*?\.platform-workspace summary:focus-visible[\s\S]*?outline: 2px solid var\(--ring\)/
    );
  });

  it('keeps inventory on the guarded shared controls', () => {
    const inventory = source('src/app/(app)/restaurant/inventory/page.tsx');
    expect(inventory).toContain("from '@/components/ui/button'");
    expect(inventory).toContain("from '@/components/ui/input'");
  });
});
