import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PharmacyFinanceRoleFields } from './pharmacy-finance-role-fields';

afterEach(cleanup);
const submitted = () =>
  JSON.parse(String(new FormData(document.querySelector('form')!).get('permissions')));

it('ticks finance reads and transactions independently and preserves unrelated role permissions', () => {
  const retained = { capability: 'pharmacy:orders', effect: 'ALLOW' as const };
  render(
    <form>
      <PharmacyFinanceRoleFields initial={[retained]} />
    </form>
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'See accounts' }));
  expect(submitted()).toEqual([retained, { capability: 'finance:read', effect: 'ALLOW' }]);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Manage account transactions' }));
  expect(submitted()).toEqual([
    retained,
    { capability: 'finance:read', effect: 'ALLOW' },
    { capability: 'finance:manage', effect: 'ALLOW' },
  ]);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Manage account transactions' }));
  expect(submitted()).toEqual([retained, { capability: 'finance:read', effect: 'ALLOW' }]);
});

it('unticks inherited access with a precise denial and respects a broader deny', () => {
  const wildcard = { capability: 'finance:*', effect: 'ALLOW' as const };
  const view = render(
    <form>
      <PharmacyFinanceRoleFields initial={[wildcard]} />
    </form>
  );
  const write = screen.getByRole('checkbox', { name: 'Manage account transactions' });
  fireEvent.click(write);
  expect(submitted()).toEqual([wildcard, { capability: 'finance:manage', effect: 'DENY' }]);
  fireEvent.click(write);
  expect(submitted()).toEqual([wildcard]);
  view.unmount();
  render(
    <form>
      <PharmacyFinanceRoleFields initial={[{ ...wildcard, effect: 'DENY' }]} />
    </form>
  );
  expect(screen.getByRole('checkbox', { name: /See accounts.*blocked/ })).toHaveAttribute(
    'aria-disabled',
    'true'
  );
  expect(submitted()).toEqual([{ ...wildcard, effect: 'DENY' }]);
});
