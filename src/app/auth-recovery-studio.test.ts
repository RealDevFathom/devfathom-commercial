import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const routePages = [
  'forgot-password/page.tsx',
  'reset-password/[token]/page.tsx',
  'invite/[token]/page.tsx',
];

const recoveryFlowFiles = [
  ...routePages,
  'forgot-password/forgot-password-form.tsx',
  'reset-password/[token]/reset-password-form.tsx',
  'invite/[token]/accept-invite-form.tsx',
];

const recoveryShellPath = '../components/auth/auth-recovery-shell.tsx';

const source = (path: string) => readFileSync(resolve(process.cwd(), 'src/app', path), 'utf8');
const recoveryShell = () => source(recoveryShellPath);

describe('Studio account-recovery composition', () => {
  it.each(routePages)('%s uses the shared split authentication shell', (path) => {
    expect(source(path)).toContain('<AuthRecoveryShell');
  });

  it.each([...recoveryFlowFiles, recoveryShellPath])(
    '%s does not restore legacy or decorative styling',
    (path) => {
      expect(source(path)).not.toMatch(/#[\da-f]{3,8}/i);
      expect(source(path)).not.toMatch(
        /(?:text|bg|border|ring)-(?:brass|teal)|backdrop-blur|blur-\[120px\]|shadow-(?:lg|xl|2xl)/
      );
    }
  );

  it('delegates recovery and every public auth layout to one Studio shell', () => {
    expect(recoveryShell()).toContain('<AuthShell context={context}>');
    for (const path of ['login/page.tsx', 'login/register/page.tsx', 'login/till/page.tsx']) {
      expect(source(path)).toContain('<AuthShell');
      expect(source(path)).not.toContain('<LoginHero');
    }
    const shell = source('../components/auth/auth-shell.tsx');
    expect(shell).toContain('studio-auth-main');
    expect(shell).toContain('max-w-[25rem]');
    expect(shell).toContain('max-w-[34rem]');
    expect(shell).toContain('href="#main-content"');
    expect(shell).toContain('id="main-content"');
    expect(shell).toContain('tabIndex={-1}');
    expect(shell).toContain('focus:not-sr-only');
  });

  it('gives every async recovery state a page heading', () => {
    expect(source('reset-password/[token]/reset-password-form.tsx').match(/<h1/g)).toHaveLength(4);
    expect(source('invite/[token]/accept-invite-form.tsx').match(/<h1/g)).toHaveLength(3);
    expect(source('forgot-password/forgot-password-form.tsx').match(/<h1/g)).toHaveLength(2);
  });
});
