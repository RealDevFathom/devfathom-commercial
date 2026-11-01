import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import ExpiryLoading from './expiry/loading';
import ImportLoading from './import/loading';
import ImportsLoading from './imports/loading';
import InventoryLoading from './loading';
import TransfersLoading from './transfers/loading';

afterEach(cleanup);

describe('inventory loading states', () => {
  it.each<[string, ComponentType, string, string]>([
    ['inventory', InventoryLoading, 'Inventory', 'Loading pharmacy inventory'],
    ['expiry', ExpiryLoading, 'Expiry board', 'Loading pharmacy expiry board'],
    ['import', ImportLoading, 'Import opening stock', 'Loading opening stock import'],
    ['imports', ImportsLoading, 'Imported stock', 'Loading imported stock'],
    ['transfers', TransfersLoading, 'Stock transfers', 'Loading stock transfers'],
  ])('the %s route loads under its own title', (_route, Loading, heading, status) => {
    render(<Loading />);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: status })).toBeInTheDocument();
  });

  it.each<[string, ComponentType]>([
    ['expiry', ExpiryLoading],
    ['import', ImportLoading],
    ['imports', ImportsLoading],
    ['transfers', TransfersLoading],
  ])('the %s route does not reuse the inventory title', (_route, Loading) => {
    render(<Loading />);
    expect(screen.queryByRole('heading', { level: 1, name: 'Inventory' })).not.toBeInTheDocument();
  });
});
