import { act } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PreferenceBootstrap } from './preference-bootstrap';

function getBootstrapScript(nonce?: string) {
  const markup = renderToStaticMarkup(<PreferenceBootstrap nonce={nonce} />);
  const document = new DOMParser().parseFromString(markup, 'text/html');

  return { markup, script: document.querySelector('script') };
}

describe('PreferenceBootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    for (const attribute of ['density', 'type', 'accent', 'layout', 'icons', 'theme']) {
      document.documentElement.removeAttribute(`data-${attribute}`);
    }
    document.documentElement.style.colorScheme = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('has one server-rendered script and one execution boundary per document', () => {
    const { markup, script } = getBootstrapScript('request-nonce');

    expect(markup.match(/id="apply-user-preferences"/g)).toHaveLength(1);
    expect(script).not.toBeNull();
    expect(script?.hasAttribute('data-nscript')).toBe(false);
    expect(script?.getAttribute('nonce')).toBe('request-nonce');
  });

  it('preserves the saved preference allowlist and defaults', () => {
    localStorage.setItem(
      'devfathom-prefs',
      JSON.stringify({
        density: 'compact',
        type: 'lg',
        accent: 'invalid',
        layout: 'top',
        icons: 'invalid',
      })
    );
    localStorage.setItem('theme', 'dark');

    const { script } = getBootstrapScript();
    window.eval(script?.textContent ?? '');

    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    expect(document.documentElement).toHaveAttribute('data-type', 'lg');
    expect(document.documentElement).toHaveAttribute('data-accent', 'quiet');
    expect(document.documentElement).toHaveAttribute('data-layout', 'top');
    expect(document.documentElement).toHaveAttribute('data-icons', 'numeric');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('keeps html-root suppression narrow enough for descendant mismatches to surface', async () => {
    const serverMarkup = renderToString(
      <div suppressHydrationWarning>
        <span>server</span>
      </div>
    );
    const container = document.createElement('main');
    container.innerHTML = serverMarkup;
    document.body.appendChild(container);
    const recoverableErrors: unknown[] = [];

    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(
        container,
        <div suppressHydrationWarning>
          <span>client</span>
        </div>,
        { onRecoverableError: (error) => recoverableErrors.push(error) }
      );
    });

    expect(recoverableErrors).toHaveLength(1);
    await act(async () => root.unmount());
  });
});
