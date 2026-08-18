import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OrdersConsole } from './orders-console';

describe('OrdersConsole', () => {
  it('renders its heading', () => {
    render(<OrdersConsole />);
    expect(screen.getByRole('heading', { name: 'Orders' })).toBeInTheDocument();
  });
});
