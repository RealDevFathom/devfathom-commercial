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
    fireEvent.change(screen.getByLabelText('Modifier option IDs'), {
      target: { value: 'option-1, option-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));

    expect(onAdd).toHaveBeenCalledWith({
      menuItemId: 'item-1',
      quantity: 3,
      course: 2,
      seatNumber: 4,
      modifierOptionIds: ['option-1', 'option-2'],
    });
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
});
