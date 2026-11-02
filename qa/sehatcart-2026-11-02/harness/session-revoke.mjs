// Sign in a fresh cashier session, copy its cookie, sign out, then replay the copied cookie.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { browser, closeBrowser, BASE, SCRATCH, pkt, save } from './lib.mjs';
const require = createRequire((process.env.QA_REPO ?? '/home/user/devfathom-commercial') + '/package.json');
const { request } = require('playwright');
const CREDS = JSON.parse(fs.readFileSync(process.env.QA_CREDS ?? path.join(SCRATCH, 'secrets/creds.json'), 'utf8'));
const b = await browser();
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('form[data-hydrated="true"]', { timeout: 30000 }).catch(() => {});
await page.fill('#email', CREDS.cashier.email);
await page.fill('#password', CREDS.cashier.password);
await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45000 }), page.click('button[type="submit"]')]);
const copied = (await ctx.cookies()).filter((c) => c.name.includes('session-token'));
const cookieHeader = copied.map((c) => `${c.name}=${c.value}`).join('; ');
const probe = async (label) => {
  const r = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { cookie: cookieHeader } });
  const res = await r.get('/api/trpc/pharmacySales.counterBranches');
  const sess = await (await r.get('/api/auth/session')).json().catch(() => null);
  const out = { label, trpcStatus: res.status(), sessionUser: sess?.user ? { status: sess.user.status, sessionRevoked: sess.user.sessionRevoked, reason: sess.user.sessionInvalidReason } : null, at: pkt() };
  console.log(JSON.stringify(out));
  await r.dispose();
  return out;
};
const before = await probe('before sign-out (copied cookie)');
// Sign out through the UI path (Auth.js signout with CSRF)
const csrf = await (await ctx.request.get(BASE + '/api/auth/csrf')).json();
const so = await ctx.request.post(BASE + '/api/auth/signout', { form: { csrfToken: csrf.csrfToken, callbackUrl: BASE + '/login' }, maxRedirects: 0 });
console.log('signout status', so.status());
await page.waitForTimeout(1500);
const after = await probe('after sign-out (replayed copied cookie)');
save('session-revoke.json', { before, after });
await ctx.close();
await closeBrowser();
