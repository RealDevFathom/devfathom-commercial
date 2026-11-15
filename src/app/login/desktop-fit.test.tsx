import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginHero } from './login-hero';

// DEV-674: the sign-in page must fit one desktop screen; the receipt sample in
// the hero used to push the page past the bottom of a laptop viewport.
const globals = readFileSync(join(__dirname, '..', 'globals.css'), 'utf8');
const pharmacyCss = readFileSync(
  join(__dirname, '..', '..', 'components', 'pharmacy', 'auth-screens.module.css'),
  'utf8'
);

function mediaBlock(css: string, query: string) {
  const start = css.indexOf(`@media ${query} {\n  .studio-auth:not(.studio-auth-register)`);
  expect(start, `missing sign-in rules under @media ${query}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('\n}\n', start);
  return css.slice(start, end);
}

function rule(block: string, selector: string) {
  const start = block.indexOf(`${selector} {`);
  expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  return block.slice(start, block.indexOf('}', start));
}

afterEach(cleanup);

describe('sign-in fits the desktop viewport', () => {
  it('locks the desktop sign-in shell, hero and form panel to one viewport', () => {
    const desktop = mediaBlock(globals, '(min-width: 1024px)');
    expect(rule(desktop, '.studio-auth:not(.studio-auth-register)')).toMatch(
      /block-size:\s*100dvh;/
    );
    const hero = rule(desktop, '.studio-auth:not(.studio-auth-register) .studio-auth-hero');
    expect(hero).toMatch(/block-size:\s*100dvh;/);
    expect(hero).toMatch(/min-block-size:\s*0;/);
    const main = rule(desktop, '.studio-auth:not(.studio-auth-register) .studio-auth-main');
    expect(main).toMatch(/block-size:\s*100dvh;/);
    expect(main).toMatch(/overflow-y:\s*auto;/);
    // Centred content that overflows must stay reachable from the top.
    expect(main).toMatch(/align-items:\s*safe center;/);
  });

  it('drops decorative sample detail on short laptop screens', () => {
    const short = mediaBlock(globals, '(min-width: 1024px) and (max-height: 800px)');
    expect(
      rule(short, '.studio-auth:not(.studio-auth-register) .studio-auth-hero [data-sample-extra]')
    ).toMatch(/display:\s*none;/);
    const shorter = mediaBlock(globals, '(min-width: 1024px) and (max-height: 680px)');
    expect(
      rule(
        shorter,
        '.studio-auth:not(.studio-auth-register) .studio-auth-hero [data-hero-description]'
      )
    ).toMatch(/display:\s*none;/);
  });

  it('scales the pharmacy hero headline and spacing with the viewport height', () => {
    expect(rule(pharmacyCss, '.pharmacy:not(.registration) :global(.studio-auth-hero)')).toMatch(
      /gap:\s*clamp\([^)]*dvh/
    );
    expect(rule(pharmacyCss, '.pharmacy:not(.registration) .introduction > p:first-child')).toMatch(
      /font-size:\s*clamp\(.*dvh/
    );
  });

  it.each(['pharmacy', 'restaurant'] as const)(
    'marks the %s receipt sample detail that can be dropped',
    (vertical) => {
      const { container } = render(<LoginHero vertical={vertical} />);
      const extras = container.querySelectorAll('[data-sample-extra]');
      expect(extras).toHaveLength(vertical === 'pharmacy' ? 2 : 1);
      // The receipt itself and its first lines always stay visible.
      expect(screen.getByText(vertical === 'pharmacy' ? 'Receipt 0418' : 'KOT 0412')).toBeVisible();
      expect(container.querySelectorAll('[data-hero-description]')).toHaveLength(1);
    }
  );

  it('keeps registration on its long-form layout', () => {
    const { container } = render(<LoginHero vertical="pharmacy" registration />);
    expect(container.querySelectorAll('[data-sample-extra]')).toHaveLength(0);
  });
});
