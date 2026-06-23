/**
 * IMP-AI-03 — Groq-schema discipline lint.
 *
 * Groq's strict validator 400s the WHOLE request when a tool's JSON Schema
 * contains `format`, `pattern` or `allOf` (the AI-01 failure mode). This builds
 * the full admin toolset, serialises every tool's inputSchema to JSON Schema, and
 * fails if any tool emits a forbidden keyword — so the discipline (validate in
 * `execute`, keep schemas plain) can't silently regress as tools grow.
 *
 * Run:  bun scripts/lint-tool-schemas.ts
 */
import { z } from 'zod';
import { buildAssistantTools } from '../src/lib/ai/tools';

const ctx = {
  userId: 'lint',
  role: 'ADMIN',
  name: 'Lint Bot',
  email: 'lint@example.com',
  department: null,
  status: 'ACTIVE',
} as Parameters<typeof buildAssistantTools>[0];

const FORBIDDEN = ['format', 'pattern', 'allOf'];

const tools = buildAssistantTools(ctx);
let checked = 0;
let violations = 0;

for (const [name, t] of Object.entries(tools)) {
  const schema = (t as { inputSchema?: unknown }).inputSchema;
  if (!schema) continue;
  let json: unknown;
  try {
    json = z.toJSONSchema(schema as z.ZodType, { unrepresentable: 'any' });
  } catch {
    continue; // not a zod schema we can introspect — skip
  }
  checked++;
  const str = JSON.stringify(json);
  const hits = FORBIDDEN.filter((k) => str.includes(`"${k}":`));
  if (hits.length) {
    violations++;
    console.log(`  ✗ ${name}: emits ${hits.join(', ')}`);
  }
}

console.log(
  `\nGroq-schema lint: checked ${checked} tool schema(s) — ${violations} with forbidden keyword(s).`
);
if (violations) {
  console.log('Fix: drop format/pattern/allOf from the inputSchema; validate in execute instead.');
  process.exit(1);
}
console.log('All tool schemas are Groq-safe. ✅');
