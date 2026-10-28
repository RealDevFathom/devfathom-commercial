import { readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const sourceRoot = resolve(process.argv[2] ?? 'src');
const testOnlyDirectories = new Set(['testing', 'test-support']);
const testFilePattern = /\.(?:test|spec)\./i;

async function prune(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (testOnlyDirectories.has(entry.name) && basename(directory) === 'lib') {
        await rm(path, { recursive: true, force: true });
      } else {
        await prune(path);
      }
    } else if (testFilePattern.test(entry.name)) {
      await rm(path);
    }
  }
}

await prune(sourceRoot);
