import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from './button';

describe('Button', () => {
  it('offers an explicit 44px touch-target size', () => {
    render(<Button size="touch">Touch action</Button>);

    const button = screen.getByRole('button', { name: 'Touch action' });
    expect(button).toHaveClass('h-11');
    expect(button).not.toHaveClass('h-8');
  });
});
