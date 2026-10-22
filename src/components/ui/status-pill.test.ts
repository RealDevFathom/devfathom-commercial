import { describe, expect, it } from 'vitest';

import { statusPillVariants } from './status-pill';

describe('statusPillVariants', () => {
  it('keeps info labels readable without relying on tenant-controlled primary colors', () => {
    const classes = statusPillVariants({ tone: 'info' });

    expect(classes).toContain('bg-muted');
    expect(classes).toContain('text-foreground');
    expect(classes).not.toMatch(/(?:bg|text)-primary/);
  });
});
