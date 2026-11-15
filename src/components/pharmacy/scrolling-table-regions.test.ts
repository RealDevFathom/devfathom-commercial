import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const regions = [
  ['dispensing/prescriptions-console.tsx', 'Captured prescriptions'],
  ['dispensing/controlled-register-console.tsx', 'Controlled medicine register'],
  ['staged-medicine-catalogue.tsx', 'Staged medicine catalogue'],
  ['../../app/(app)/pharmacy/inventory/page.tsx', 'Pharmacy inventory batches'],
  ['../../app/(app)/pharmacy/marketing/page.tsx', 'Marketing campaigns'],
] as const;

describe('pharmacy scrolling table regions', () => {
  it.each(regions)('%s is named, keyboard reachable, and visibly focused', (file, name) => {
    const source = readFileSync(resolve(__dirname, file), 'utf8');
    const openingTag = file.endsWith('inventory/page.tsx')
      ? source.match(/<Table\s+containerProps=\{\{[\s\S]*?\}\}\s*>/)?.[0]
      : source.match(
          new RegExp(
            `<div\\s+[\\s\\S]*?aria-label=["']${name}["'][\\s\\S]*?tabIndex=\\{0\\}[\\s\\S]*?>`
          )
        )?.[0];

    expect(openingTag).toBeDefined();
    if (file.endsWith('inventory/page.tsx')) {
      expect(openingTag).toContain("role: 'region'");
      expect(openingTag).toContain(`'aria-label': '${name}'`);
      expect(openingTag).toContain('tabIndex: 0');
    } else {
      expect(openingTag).toContain('role="region"');
    }
    expect(openingTag).toContain('overflow-x-auto');
    expect(openingTag).toContain('focus-visible:outline-2');
    expect(openingTag).toContain('focus-visible:outline-ring');
  });
});
