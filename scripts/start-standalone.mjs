import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Next's standalone output omits these assets. Ship the same files as Docker
// before starting the generated server, including fonts and license notices.
const standalone = resolve('.next/standalone');
cpSync(resolve('public'), resolve(standalone, 'public'), { recursive: true });
cpSync(resolve('.next/static'), resolve(standalone, '.next/static'), { recursive: true });
await import(pathToFileURL(resolve(standalone, 'server.js')).href);
