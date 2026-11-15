import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { ReadinessChecklistItem } from '@/components/onboarding/readiness-checklist';
import { pharmacyChecklistLinkName } from './pharmacy-first-sale';

afterEach(cleanup);

it('uniquely matches all six journey links with their real accessible suffix', () => {
  const destinations = [
    ['Branches and locations', 'Create or review stock locations', '/pharmacy/inventory'],
    ['Premises and licences', 'Open regulatory profile', '/pharmacy/regulatory'],
    ['Medicine catalog readiness', 'Set up medicines and packs', '/pharmacy/medicines'],
    ['Parties and balances', 'Set up suppliers', '/pharmacy/purchasing/suppliers'],
    ['Opening stock readiness', 'Import opening stock', '/pharmacy/inventory/import'],
    ['Readiness and parallel run', 'Open pharmacy counter', '/pharmacy/counter'],
  ] as const;
  render(
    <ol>
      {destinations.map(([label, linkLabel, href], index) => (
        <ReadinessChecklistItem
          key={label}
          row={{
            key: label,
            step: index + 1,
            label,
            linkLabel,
            href,
            state: 'NEEDS_YOU',
            why: 'Complete setup.',
          }}
        />
      ))}
    </ol>
  );
  for (const [gate, link, href] of destinations) {
    // Preserve the original failure: the bare exact name cannot select this DOM.
    expect(screen.queryByRole('link', { name: link })).toBeNull();
    const name = pharmacyChecklistLinkName(gate, link);
    const matches = screen.getAllByRole('link', { name });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toHaveAttribute('href', href);
    expect(matches[0]).toHaveTextContent(link);
    expect(name.test(`${link}— ${gate}`)).toBe(true);
    expect(name.test(`${link} — ${gate}`)).toBe(true);
    expect(name.test(`${link} — ${gate} extra`)).toBe(false);
    expect(name.test(`Other ${link} — ${gate}`)).toBe(false);
    expect(name.test(`${link} — Wrong gate`)).toBe(false);
  }
});
