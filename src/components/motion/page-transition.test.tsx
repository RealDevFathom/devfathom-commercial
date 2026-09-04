import { render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

const motionState = vi.hoisted(() => ({ reduce: false }));

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('motion/react', () => ({
  useReducedMotion: () => motionState.reduce,
  m: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      transition: _transition,
      ...props
    }: ComponentPropsWithoutRef<'div'> & {
      initial?: unknown;
      animate?: unknown;
      transition?: unknown;
    }) => {
      void _initial;
      void _animate;
      void _transition;
      return (
        <div data-motion-element="true" {...props}>
          {children}
        </div>
      );
    },
  },
}));

import { PageTransition } from './page-transition';

describe('PageTransition', () => {
  it('renders static visible content when reduced motion is requested', () => {
    motionState.reduce = true;

    render(<PageTransition className="stage">Dashboard</PageTransition>);

    const transition = screen.getByText('Dashboard');
    expect(transition).toHaveAttribute('data-slot', 'page-transition');
    expect(transition).toHaveClass('stage');
    expect(transition).not.toHaveAttribute('data-motion-element');
  });

  it('retains the route animation when reduced motion is not requested', () => {
    motionState.reduce = false;

    render(<PageTransition>Dashboard</PageTransition>);

    expect(screen.getByText('Dashboard')).toHaveAttribute('data-motion-element', 'true');
  });
});
