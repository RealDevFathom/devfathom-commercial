import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'tenant.example.test' }),
}));

import { ApiDocsContent } from './api-docs-content';

afterEach(cleanup);

async function renderFor(vertical?: string | null) {
  render(await ApiDocsContent({ vertical }));
  return document.body.textContent ?? '';
}

describe('API docs content (#980)', () => {
  it.each(['PHARMACY', 'AGENCY', 'RESTAURANT', 'HOSPITALITY', undefined])(
    'never names internal developer tooling for vertical %s',
    async (vertical) => {
      const text = await renderFor(vertical);
      expect(text).not.toMatch(/Claude/i);
      expect(text).not.toContain('CLAUDE.md');
      expect(text).not.toMatch(/Cursor/);
      expect(screen.getByText('3 · Use from an integration')).toBeInTheDocument();
    }
  );

  it('does not suggest agency task scopes to a pharmacy', async () => {
    const text = await renderFor('PHARMACY');
    expect(text).not.toContain('tasks:read');
    expect(text).not.toContain('tasks:write');
    expect(text).not.toMatch(/task/i);
  });

  it('keeps the task scope example for the agency workspace', async () => {
    const text = await renderFor('AGENCY');
    expect(text).toContain('tasks:read');
    expect(text).toContain('tasks:write');
  });
});
