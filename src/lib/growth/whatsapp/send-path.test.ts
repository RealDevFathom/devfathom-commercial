import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Campaign and AI code may queue marketing through `enqueueMarketing` only.
 * The queue drain, the provider, and the STOP confirmation are the send path.
 */
const ALLOWED = new Set([
  'src/lib/growth/whatsapp/queue.ts',
  'src/lib/growth/whatsapp/send.ts',
  'src/lib/growth/whatsapp/evolution.ts',
  'src/lib/growth/whatsapp/provider.ts',
  'src/lib/growth/consent.ts',
  'src/app/api/growth/whatsapp/webhook/route.ts',
]);

const ROOTS = ['src/lib/growth', 'src/lib/ai', 'src/server', 'src/app'];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    found.push(path);
  }
  return found;
}

describe('marketing sends go through enqueueMarketing', () => {
  it('keeps provider sends out of campaign and AI modules', () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      let files: string[] = [];
      try {
        files = sourceFiles(join(process.cwd(), root));
      } catch {
        continue;
      }
      for (const file of files) {
        const relative = file.slice(process.cwd().length + 1);
        if (ALLOWED.has(relative)) continue;
        const source = readFileSync(file, 'utf8');
        if (/\bsendText\s*\(/.test(source) || source.includes('createEvolutionProvider')) {
          violations.push(relative);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
