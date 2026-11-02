// axe-core WCAG 2.0/2.1 A+AA scan of key pages. Usage: node axe.mjs [scheme]
import { createRequire } from 'node:module';
import { roleContext, closeBrowser, BASE, save } from './lib.mjs';
const require = createRequire((process.env.QA_REPO ?? '/home/user/devfathom-commercial') + '/package.json');
const { AxeBuilder } = require('@axe-core/playwright');
const scheme = process.argv[2] ?? 'light';
const targets = [
  [null, '/login'],
  ['cashier', '/pharmacy/counter'],
  ['cashier', '/dashboard'],
  ['owner', '/pharmacy/purchasing/receiving'],
  ['owner', '/pharmacy/counter/close'],
  ['pharmacist', '/pharmacy/prescriptions'],
  ['owner', '/pharmacy/inventory'],
  ['owner', '/pharmacy/reports'],
];
const summary = [];
for (const [role, route] of targets) {
  const ctx = await roleContext(role, { colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const v = res.violations.map((x) => ({ id: x.id, impact: x.impact, n: x.nodes.length, help: x.help, sample: x.nodes.slice(0, 2).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary ?? '').split('\n').slice(1, 2).join('').slice(0, 160)) }));
  summary.push({ role, route, violations: v });
  console.log(`\n== ${role ?? 'anon'} ${route} (${scheme}) — ${v.length} rules`);
  for (const x of v) console.log(`  [${x.impact}] ${x.id} ×${x.n}: ${x.help}\n     e.g. ${x.sample[0] ?? ''}`);
  await ctx.close();
}
save(`axe-${scheme}.json`, summary);
await closeBrowser();
