import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

function Example({ size = 'default' }: { size?: 'sm' | 'default' }) {
  const [value, setValue] = useState<string | null>('cash');
  return (
    <>
      <label id="tender-label">Tender</label>
      <p id="tender-help">Choose how the customer pays.</p>
      <Select
        value={value}
        onValueChange={setValue}
        items={[
          { value: 'cash', label: 'Cash' },
          { value: 'card', label: 'Card' },
          { value: 'unavailable', label: 'Unavailable' },
        ]}
      >
        <SelectTrigger size={size} aria-labelledby="tender-label" aria-describedby="tender-help">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="cash">Cash</SelectItem>
          <SelectItem value="card">Card</SelectItem>
          <SelectItem value="unavailable" disabled>
            Unavailable
          </SelectItem>
        </SelectContent>
      </Select>
    </>
  );
}

describe('shared Select accessibility', () => {
  for (const size of ['default', 'sm'] as const) {
    it(`gives the ${size} trigger and options 44px target floors`, async () => {
      render(<Example size={size} />);
      const trigger = screen.getByRole('combobox', { name: 'Tender' });
      expect(trigger).toHaveAccessibleDescription('Choose how the customer pays.');
      expect(trigger).toHaveClass('min-h-11', 'min-w-11');
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      const option = await screen.findByRole('option', { name: 'Card' });
      expect(option).toHaveClass('min-h-11');
    });
  }

  it('announces selection, supports keyboard selection, and restores focus on Escape', async () => {
    render(<Example />);
    const trigger = screen.getByRole('combobox', { name: 'Tender' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const cash = await screen.findByRole('option', { name: 'Cash' });
    expect(cash).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Unavailable' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    const card = screen.getByRole('option', { name: 'Card' });
    fireEvent.keyDown(cash, { key: 'ArrowDown' });
    await waitFor(() => expect(card).toHaveFocus());
    // jsdom does not synthesize the click a browser generates for Enter.
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.click(card, { detail: 0 });
    await waitFor(() => expect(trigger).toHaveTextContent('Card'));
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findByRole('listbox');
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
