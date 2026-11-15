import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import PharmacyAccountsPage from './page';

const accountsDir = path.join(process.cwd(), 'src/app/(app)/pharmacy/accounts');

describe('pharmacy accounts index (DEV-502)', () => {
  it('renders an index page instead of a 404', () => {
    render(<PharmacyAccountsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Statements' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Profit and loss/ })).toHaveAttribute(
      'href',
      '/pharmacy/accounts/profit-loss'
    );
  });

  it('links every accounts page and nothing that does not exist', () => {
    const pages = readdirSync(accountsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(path.join(accountsDir, entry.name, 'page.tsx')))
      .map((entry) => `/pharmacy/accounts/${entry.name}`)
      .sort();

    render(<PharmacyAccountsPage />);
    const links = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .sort();

    expect(pages.length).toBeGreaterThan(0);
    expect(links).toEqual(pages);
  });
});
