// Login throttle probe with a NON-EXISTENT account (never a real QA user).
import { createRequire } from 'node:module';
import { BASE, pkt, save } from './lib.mjs';
const require = createRequire(
  (process.env.QA_REPO ?? '/home/user/devfathom-commercial') + '/package.json'
);
const { request } = require('playwright');
const email = `qa.ratelimit.probe.${Date.now()}@example.com`;
const ctx = await request.newContext({ baseURL: BASE, maxRedirects: 0 });
const out = [];
for (let i = 1; i <= 13; i++) {
  const csrf = await (await ctx.get('/api/auth/csrf')).json();
  const t0 = Date.now();
  const res = await ctx.post('/api/auth/callback/credentials', {
    form: {
      email,
      password: 'definitely-wrong-password-' + i,
      totp: '',
      csrfToken: csrf.csrfToken,
      callbackUrl: BASE + '/dashboard',
    },
  });
  const ms = Date.now() - t0;
  const loc = res.headers()['location'] ?? '';
  out.push({
    i,
    status: res.status(),
    ms,
    location: loc.replace(BASE, '').slice(0, 120),
    at: pkt(),
  });
  console.log(i, res.status(), `${ms}ms`, loc.replace(BASE, '').slice(0, 120));
}
save('ratelimit.json', out);
await ctx.dispose();
