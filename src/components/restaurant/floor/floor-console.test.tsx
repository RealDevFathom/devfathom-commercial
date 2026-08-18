import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FloorConsole } from './floor-console';

describe('FloorConsole', () => {
  it('renders its heading', () => {
    render(<FloorConsole />);
    expect(screen.getByRole('heading', { name: 'Floor' })).toBeInTheDocument();
  });
});
