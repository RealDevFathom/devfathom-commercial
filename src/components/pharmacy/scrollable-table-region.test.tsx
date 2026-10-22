import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ScrollableTableRegion } from './scrollable-table-region';

describe('ScrollableTableRegion', () => {
  it('exposes an overflow table as a named keyboard stop', () => {
    render(
      <ScrollableTableRegion label="Available inventory">
        <table>
          <tbody>
            <tr>
              <td>Medicine</td>
            </tr>
          </tbody>
        </table>
      </ScrollableTableRegion>
    );

    const region = screen.getByRole('region', { name: 'Available inventory' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveClass('overflow-x-auto', 'focus-visible:outline-ring');
  });
});
