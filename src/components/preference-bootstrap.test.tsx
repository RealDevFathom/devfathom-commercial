import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let insertedHead: (() => React.ReactNode) | undefined;

vi.mock('next/navigation', () => ({
  useServerInsertedHTML: (callback: () => React.ReactNode) => {
    insertedHead = callback;
  },
}));

import { PreferenceBootstrap } from './preference-bootstrap';

describe('PreferenceBootstrap', () => {
  beforeEach(() => {
    insertedHead = undefined;
    localStorage.clear();
    document.documentElement.removeAttribute('data-density');
    document.documentElement.removeAttribute('data-theme');
  });

  it('registers one server head script without rendering a client script node', () => {
    const consoleError = vi.spyOn(console, 'error');
    const { container } = render(<PreferenceBootstrap />);

    expect(container.querySelector('script')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    expect(insertedHead).toBeTypeOf('function');

    const headMarkup = renderToStaticMarkup(<>{insertedHead?.()}</>);
    expect(headMarkup.match(/id="apply-user-preferences"/g)).toHaveLength(1);

    consoleError.mockRestore();
  });

  it('applies saved appearance preferences before hydration', () => {
    localStorage.setItem('devfathom-prefs', JSON.stringify({ density: 'compact', type: 'lg' }));
    localStorage.setItem('theme', 'dark');
    render(<PreferenceBootstrap />);

    const scriptMarkup = renderToStaticMarkup(<>{insertedHead?.()}</>);
    const script = new DOMParser()
      .parseFromString(scriptMarkup, 'text/html')
      .querySelector('script');
    expect(script?.textContent).toBeTruthy();

    window.eval(script?.textContent ?? '');

    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    expect(document.documentElement).toHaveAttribute('data-type', 'lg');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});
