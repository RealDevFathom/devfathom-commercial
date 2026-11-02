export function authSessionCookieNames(cookieHeader: string | null) {
  const names = new Set(['authjs.session-token', '__Secure-authjs.session-token']);
  for (const cookie of cookieHeader?.split(';') ?? []) {
    const separatorIndex = cookie.indexOf('=');
    if (separatorIndex === -1) continue;

    const name = cookie.slice(0, separatorIndex).trim();
    if (/^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name)) {
      names.add(name);
    }
  }
  return [...names];
}
