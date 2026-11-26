import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStarterCsv } from './starter-reference';

// One approved projection is authoritative. Missing/invalid CSV must never fall back to JSON.
const bytes = readFileSync(join(process.cwd(), 'src/lib/pharmacy/migration/starter-products.csv'));
const rows = parseStarterCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export default rows;
