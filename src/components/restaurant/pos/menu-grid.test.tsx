import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MenuGrid, type EffectiveMenu } from './menu-grid';

const menu: EffectiveMenu = {
  publicationId: 'publication-1',
  channelOpen: true,
  menu: { id: 'menu-1', name: 'Dinner' },
  sections: [
    {
      id: 'section-1',
      name: 'Mains',
      items: [
        {
          id: 'item-1',
          displayName: 'Steak',
          product: { name: 'Sirloin' },
          price: '24.00',
          available: true,
          modifierGroups: [
            {
              id: 'group-1',
              name: 'Sauce',
              minSelect: 1,
              maxSelect: 2,
              options: [
                { id: 'option-1', name: 'Peppercorn', priceDelta: '0.00' },
                { id: 'option-2', name: 'Mushroom', priceDelta: '1.50' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('MenuGrid', () => {
  it('passes quantity, course, seat, and modifier IDs to add callback', () => {
    const onAdd = vi.fn();
    render(<MenuGrid menu={menu} pending={false} onAdd={onAdd} />);

    fireEvent.click(screen.getByRole('button', { name: /Steak/ }));
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Course'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Seat'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Peppercorn' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Mushroom/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));

    expect(onAdd).toHaveBeenCalledWith({
      menuItemId: 'item-1',
      quantity: 3,
      course: 2,
      seatNumber: 4,
      modifierOptionIds: ['option-1', 'option-2'],
    });
  });

  it('enforces required modifier selections by business label', () => {
    const onAdd = vi.fn();
    render(<MenuGrid menu={menu} pending={false} onAdd={onAdd} />);

    fireEvent.click(screen.getByRole('button', { name: /Steak/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Sauce requires 1–2 selections.');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('falls back to product name and disables unpriced items', () => {
    const onAdd = vi.fn();
    render(
      <MenuGrid
        menu={{
          ...menu,
          sections: [
            {
              ...menu.sections[0],
              items: [
                {
                  id: 'item-2',
                  displayName: null,
                  product: { name: 'Soup' },
                  price: null,
                  available: true,
                },
              ],
            },
          ],
        }}
        pending={false}
        onAdd={onAdd}
      />
    );

    expect(screen.getByRole('button', { name: /SoupN\/A/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('adds on Enter only for the selected item or a single exact match', () => {
    const onAdd = vi.fn();
    render(
      <MenuGrid
        menu={{
          ...menu,
          sections: [
            {
              id: 'section-2',
              name: 'Mains',
              items: [
                {
                  id: 'chicken',
                  displayName: 'Chicken',
                  product: { name: 'Chicken' },
                  price: '18.00',
                  available: true,
                },
                {
                  id: 'cheese',
                  displayName: 'Cheese plate',
                  product: { name: 'Cheese plate' },
                  price: '12.00',
                  available: true,
                  barcode: '50001111',
                },
              ],
            },
          ],
        }}
        pending={false}
        onAdd={onAdd}
      />
    );
    const search = screen.getByLabelText('Menu search');

    fireEvent.change(search, { target: { value: 'ch' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Chicken/ })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ menuItemId: 'chicken' }));

    onAdd.mockClear();
    fireEvent.change(search, { target: { value: '50001111' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ menuItemId: 'cheese' }));
  });
});
