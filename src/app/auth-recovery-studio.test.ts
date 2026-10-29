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

  it('keeps the recovery form panel geometry aligned with sign-in', () => {
    const login = source('login/page.tsx');
    const shell = recoveryShell();

    for (const layoutClass of [
      'lg:grid-cols-[minmax(0,1.08fr)_minmax(26rem,0.92fr)]',
      'w-full max-w-[25rem] animate-slide-up',
      'border-l-2 border-primary pl-5 sm:pl-6',
    ]) {
      expect(login).toContain(layoutClass);
      expect(shell).toContain(layoutClass);
    }

    expect(shell).not.toMatch(/max-w-\[30rem\]|rounded-md border|shadow-xs|\bwide\b/);
  });

  it('provides a keyboard-visible skip link to the recovery form', () => {
    expect(recoveryShell()).toContain('href="#recovery-form"');
    expect(recoveryShell()).toContain('id="recovery-form"');
    expect(recoveryShell()).toContain('focus:not-sr-only');
  });

  it('gives every async recovery state a page heading', () => {
    expect(source('reset-password/[token]/reset-password-form.tsx').match(/<h1/g)).toHaveLength(4);
    expect(source('invite/[token]/accept-invite-form.tsx').match(/<h1/g)).toHaveLength(3);
    expect(source('forgot-password/forgot-password-form.tsx').match(/<h1/g)).toHaveLength(2);
  });
});
