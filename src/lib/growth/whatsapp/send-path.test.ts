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
  // Existing utility-only pharmacy provider and consent acknowledgement.
  'src/lib/pharmacy/whatsapp/provider.ts',
  'src/lib/pharmacy/whatsapp/inbound.ts',
  'src/app/api/growth/whatsapp/webhook/route.ts',
]);

const ROOTS = ['src'];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (path === join(process.cwd(), 'src/generated')) continue;
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    found.push(path);
  }
  return found;
}

function forbiddenSource(source: string, relative: string): boolean {
  const compact = source.replace(/['"`\s+]/g, '');
  return (
    /\bsendText\b/.test(source) ||
    source.includes('createEvolutionProvider') ||
    /\[sendText\]/.test(compact) ||
    (!relative.endsWith('/whatsapp/store.ts') &&
      (source.includes('outboundGrowthStore') || /(?:\.|\[|\{)insertMessage/.test(compact) || /growthWaMessage(?:\.|\[)(?:createMany|create|upsert)/.test(compact) || /Reflect\.get\([^,]+,(?:insertMessage|growthWaMessage)/.test(compact)))
  );
}

describe('marketing sends go through enqueueMarketing', () => {
  it.each([
    "provider['send' + 'Text'](phone, body)",
    "provider['sendText'](phone, body)",
    'provider.sendText(phone, body)',
    "store['insert' + 'Message']({ direction: 'out' })",
    "store.insertMessage({ direction: 'out', status: 'queued' })",
    'const writer = outboundGrowthStore(db)',
    'prisma.growthWaMessage.create({})',
    'prisma.growthWaMessage.createMany({})',
    'prisma.growthWaMessage.upsert({})',
    'const { insertMessage: write } = store',
    "Reflect.get(store, 'insertMessage')({})",
    "Reflect.get(prisma, 'growthWaMessage').create({})",
  ])('rejects alternate send/write spelling: %s', (source) => {
    expect(forbiddenSource(source, 'src/lib/pharmacy/campaign.ts')).toBe(true);
  });
  it('keeps provider sends out of campaign and AI modules', () => {
    const violations: string[] = [];
    for (const root of ROOTS) {
      const files = sourceFiles(join(process.cwd(), root));
      for (const file of files) {
        const relative = file.slice(process.cwd().length + 1);
        if (ALLOWED.has(relative)) continue;
        const source = readFileSync(file, 'utf8');
        if (forbiddenSource(source, relative)) {
          violations.push(relative);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
