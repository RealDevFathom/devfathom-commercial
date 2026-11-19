// @vitest-environment node
/**
 * DEV-963: the full type check outgrew the standard 8 GB heap. Its largest single block was
 * the root of `googleapis`, about 900 declaration files and 170 MB of types for every Google
 * API, loaded for the two files that use Gmail; the root of `@vercel/sdk` added another 500
 * files for two API groups. Both are now imported from their own entry points. These checks
 * keep the roots out of the type-checked program and prove the narrow entry points build the
 * same clients the roots did.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoogleOAuth2, gmailClient } from '@/lib/email/google-gmail';

const repoRoot = join(__dirname, '..', '..');

/** Package roots whose declarations cost far more than the APIs this app uses. */
const HEAVY_ROOTS = ['googleapis', '@vercel/sdk'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === 'generated' || name === 'node_modules' ? [] : sourceFiles(path);
    }
    return /\.(?:ts|tsx|mts|cts)$/.test(name) ? [path] : [];
  });
}

/** Every `from`, `import(...)` or `require(...)` of a heavy package root, as `path:line`. */
function heavyRootImports(): string[] {
  const roots = HEAVY_ROOTS.map((root) => root.replace(/[/@]/g, '\\$&')).join('|');
  const pattern = new RegExp(
    `(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)['"](?:${roots})['"]`
  );
  return ['src', 'tests', 'prisma'].flatMap((dir) =>
    sourceFiles(join(repoRoot, dir)).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          pattern.test(line) ? [`${path.slice(repoRoot.length + 1)}:${index + 1}`] : []
        )
    )
  );
}

/**
 * Loads a package root at run time only, with the shape the test reads from it. The specifier
 * is not a literal, so the type check never resolves it and adds none of its declarations back.
 */
async function loadRoot<Shape>(specifier: string): Promise<Shape> {
  return import(/* @vite-ignore */ specifier);
}

describe('type-check weight of package roots (DEV-963)', () => {
  it('imports no Google API or Vercel API from its package root', () => {
    expect(heavyRootImports()).toEqual([]);
  });

  it('builds the same Google OAuth2 and Gmail clients as the googleapis root', async () => {
    const root = await loadRoot<{
      google: { auth: { OAuth2: typeof GoogleOAuth2 } };
      gmail_v1: { Gmail: abstract new (...args: never[]) => object };
    }>('googleapis');
    expect(GoogleOAuth2).toBe(root.google.auth.OAuth2);

    const auth = new GoogleOAuth2('client-id', 'client-secret', 'https://example.test/callback');
    const client = gmailClient(auth);
    expect(client).toBeInstanceOf(root.gmail_v1.Gmail);
    expect(client.context._options.auth).toBe(auth);
    expect(typeof client.users.messages.list).toBe('function');
  }, 30_000);

  it('builds the same Vercel API groups as the @vercel/sdk root', async () => {
    const root = await loadRoot<{
      Vercel: new (options: { bearerToken: string }) => { deployments: object; projects: object };
    }>('@vercel/sdk');
    const [{ Deployments }, { Projects }] = await Promise.all([
      import('@vercel/sdk/sdk/deployments.js'),
      import('@vercel/sdk/sdk/projects.js'),
    ]);
    const vercel = new root.Vercel({ bearerToken: 'placeholder-token' });
    expect(vercel.deployments).toBeInstanceOf(Deployments);
    expect(vercel.projects).toBeInstanceOf(Projects);
  }, 30_000);
});
