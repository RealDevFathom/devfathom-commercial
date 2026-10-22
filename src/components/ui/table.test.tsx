import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Table } from './table';

describe('Table', () => {
  it('can expose its scrolling viewport as a named keyboard stop', () => {
    render(
      <Table scrollAreaLabel="Available inventory">
        <tbody>
          <tr>
            <td>Medicine</td>
          </tr>
        </tbody>
      </Table>
    );

    expect(screen.getByRole('region', { name: 'Available inventory' })).toHaveAttribute(
      'tabindex',
      '0'
    );
  });
});
