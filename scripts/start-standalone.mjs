import { cpSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Next's standalone output omits these assets. Ship the same files as Docker
// before starting the generated server, including fonts and license notices.
const standalone = resolve('.next/standalone');
if (!existsSync(resolve(standalone, '.assets-staged'))) {
  rmSync(resolve(standalone, 'public'), { recursive: true, force: true });
  cpSync(resolve('public'), resolve(standalone, 'public'), {
    recursive: true,
    // Local uploads are private. Refuse symlinks as well, including innocently
    // named aliases to a private directory outside the public source tree.
    filter: (source) =>
      !['uploads', 'private-uploads'].includes(basename(source)) &&
      !lstatSync(source).isSymbolicLink(),
  });
  cpSync(resolve('.next/static'), resolve(standalone, '.next/static'), { recursive: true });
}
await import(pathToFileURL(resolve(standalone, 'server.js')).href);
