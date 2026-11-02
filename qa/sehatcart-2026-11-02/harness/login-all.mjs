import { login, closeBrowser, ROLES, trpc, disposeApis, short } from './lib.mjs';

const roles = process.argv.slice(2).length ? process.argv.slice(2) : ROLES;
for (const role of roles) {
  try {
    const r = await login(role, { force: true });
    console.log(role, 'login ok, landed', r.landed.replace(/^https?:\/\/[^/]+/, ''), `${r.ms}ms`);
  } catch (e) {
    console.log(role, 'LOGIN FAILED', String(e).slice(0, 300));
  }
}
await closeBrowser();
for (const role of roles) {
  const s = await (await import('./lib.mjs')).api(role).then((a) => a.get('/api/auth/session'));
  const j = await s.json().catch(() => null);
  const u = j?.user ?? {};
  console.log(role, 'session:', JSON.stringify({ id: u.id, role: u.role, status: u.status, org: u.organizationId, name: u.name, keys: Object.keys(u) }));
}
await disposeApis();
