/**
 * DEV-828: tRPC procedures returned whole `User` rows (`team.updateProfile`,
 * `team.layOffMember`, `organizationAdmin.updateMember`). A User row carries the
 * password verifier and the base32 TOTP seed, so any caller that saw the response
 * held the account's second factor.
 *
 * DEV-848: the same mistake returned `tokenHash` from the API-token, SCIM-token and
 * supplier-link admin screens. The guard now covers every model whose schema holds a
 * secret (a password, a token or code hash, a stored secret, an encrypted credential),
 * scans `src/server`, `src/lib` and `src/app`, and also flags a relation to such a model
 * that is included or selected whole (`include: { user: true }`).
 *
 * Two source-level rules:
 *
 * 1. Rows. Code that keeps the result of a query or write on a secret-holding model with
 *    no top-level `select` or `omit`. A call whose result is discarded (a bare `await`
 *    statement, or an element of an awaited `$transaction([...])` whose result is
 *    discarded) is allowed, because nothing can reach a response. Server-side code does
 *    have to read secrets to verify them, so the existing call sites outside `src/server`
 *    and the non-User reads inside it are listed in `REVIEWED_ROW_READS`. Each was
 *    reviewed: the row is used to verify a credential, or is mapped to an explicit shape
 *    before anything is returned. The list is an exact ratchet: a new call site fails,
 *    and a call site that gains a `select` must be removed from the list. tRPC code under
 *    `src/server` may never keep a whole `User` row.
 * 2. Relations. A relation to a secret-holding model inside `include` or `select` must
 *    carry its own `select` or `omit`. The existing exceptions, listed in
 *    `REVIEWED_RELATION_READS`, load the related row to verify a PIN, a ticket or a
 *    gateway on the server, or render it field by field in a server component. The list
 *    is the same exact ratchet.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..', '..');
const SCANNED_ROOTS = ['src/server', 'src/lib', 'src/app'];

/**
 * Column names that hold a secret or a verifier for one. Content and payload hashes do
 * not, and neither does a promotion's coupon fingerprint, which matches a printed code.
 */
const SECRET_FIELD =
  /^(password|passwordHash|secret)$|(?<!coupon)(token|code|otp|credential|state|secret)Hash$|Secret$|^encrypted[A-Z]|Ciphertext$/i;

const ROW_METHODS =
  'findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|create|createManyAndReturn|update|updateManyAndReturn|upsert|delete';

type Schema = Map<string, Map<string, string>>;

/** Model name -> field name -> field type, read from the Prisma schema. */
function parseSchema(source: string): Schema {
  const models: Schema = new Map();
  for (const block of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, string>();
    for (const line of block[2]!.split('\n')) {
      const field = /^\s*(\w+)\s+(\w+)/.exec(line);
      if (field && !line.trimStart().startsWith('@@')) fields.set(field[1]!, field[2]!);
    }
    models.set(block[1]!, fields);
  }
  return models;
}

/** Models with at least one secret column. */
function secretModels(schema: Schema): Set<string> {
  return new Set(
    [...schema]
      .filter(([, fields]) => [...fields.keys()].some((f) => SECRET_FIELD.test(f)))
      .map(([model]) => model)
  );
}

const delegateName = (model: string) => model[0]!.toLowerCase() + model.slice(1);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const isQuote = (ch: string) => ch === "'" || ch === '"' || ch === '`';

/** Index of the quote closing the string that opens at `start`. */
function stringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === source[start]) return i;
  }
  return source.length;
}

/**
 * Last index of the string or comment starting at `i`, or -1 when none starts there.
 * Parsing always starts at a known call, so a regex literal elsewhere cannot derail it.
 */
function skipLiteral(source: string, i: number): number {
  const ch = source[i]!;
  if (isQuote(ch)) return stringEnd(source, i);
  if (ch === '/' && source[i + 1] === '/') {
    const end = source.indexOf('\n', i);
    return end === -1 ? source.length : end - 1;
  }
  if (ch === '/' && source[i + 1] === '*') {
    const end = source.indexOf('*/', i + 2);
    return end === -1 ? source.length : end + 1;
  }
  return -1;
}

/** Index of the delimiter closing the one opened just before `open`, skipping strings. */
function closing(source: string, open: number): number {
  let depth = 1;
  let i = open;
  while (depth > 0 && i < source.length) {
    const ch = source[i]!;
    const literalEnd = skipLiteral(source, i);
    if (literalEnd !== -1) i = literalEnd;
    else if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    i++;
  }
  return i - 1;
}

/** Top-level `key: value` entries of an object literal (`{ ... }`). */
function entries(literal: string): { key: string; value: string }[] {
  const body = literal.trim();
  if (!body.startsWith('{')) return [];
  const out: { key: string; value: string }[] = [];
  let start = 1;
  let i = 1;
  const push = (end: number) => {
    const text = body
      .slice(start, end)
      .replace(/^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/))*/, '')
      .trim();
    const entry = /^['"]?([\w$]+)['"]?\s*(?::\s*([\s\S]*))?$/.exec(text);
    if (entry) out.push({ key: entry[1]!, value: (entry[2] ?? entry[1]!).trim() });
  };
  while (i < body.length) {
    const ch = body[i]!;
    const literalEnd = skipLiteral(body, i);
    if (literalEnd !== -1) i = literalEnd;
    else if ('{[('.includes(ch)) i = closing(body, i + 1);
    else if (ch === ',' || ch === '}') {
      push(i);
      start = i + 1;
      if (ch === '}') break;
    }
    i++;
  }
  return out;
}

/** True when the call's argument object has a top-level `select` or `omit` key. */
function restrictsFields(argument: string): boolean {
  return entries(argument).some(({ key }) => key === 'select' || key === 'omit');
}

/** True when nothing can observe the call's result. */
function resultDiscarded(source: string, callStart: number): boolean {
  // Walk back over the receiver (`ctx.db`, `tx`, `this.db`, ...).
  let receiverStart = callStart;
  while (receiverStart > 0 && /[\w$.]/.test(source[receiverStart - 1]!)) receiverStart--;
  const lineStart = source.lastIndexOf('\n', receiverStart - 1) + 1;
  const before = source.slice(lineStart, receiverStart);

  // `await ctx.db.user.update({...});` as its own statement.
  if (/^\s*await\s+$/.test(before)) return true;

  // An element of `await ctx.db.$transaction([ ... ]);` whose result is discarded.
  if (/^\s*$/.test(before)) {
    const tx = source.lastIndexOf('$transaction([', receiverStart);
    if (tx === -1) return false;
    const txLineStart = source.lastIndexOf('\n', tx) + 1;
    if (!/^\s*await\s+[\w$.]+\.$/.test(source.slice(txLineStart, tx))) return false;
    // Still inside that array literal?
    let depth = 0;
    for (let i = tx + '$transaction('.length; i < receiverStart; i++) {
      if (source[i] === '[') depth++;
      else if (source[i] === ']') depth--;
    }
    return depth > 0;
  }
  return false;
}

type Finding = { line: number; model: string };

class ResponseGuard {
  private readonly secret: Set<string>;
  private readonly byDelegate: Map<string, string>;
  private readonly call: RegExp;

  constructor(private readonly schema: Schema) {
    this.secret = secretModels(schema);
    this.byDelegate = new Map([...schema.keys()].map((model) => [delegateName(model), model]));
    this.call = new RegExp(`\\.([\\w$]+)\\.(${ROW_METHODS})\\(`, 'g');
  }

  get secretModelNames(): string[] {
    return [...this.secret].sort();
  }

  /** Each kept, argument-bearing delegate call: its model, line and argument text. */
  private *calls(source: string) {
    for (const match of source.matchAll(this.call)) {
      const model = this.byDelegate.get(match[1]!);
      if (!model) continue;
      if (resultDiscarded(source, match.index)) continue;
      const open = match.index + match[0].length;
      yield {
        model,
        line: source.slice(0, match.index).split('\n').length,
        argument: source.slice(open, closing(source, open)),
      };
    }
  }

  /** Rule 1: kept secret-model rows with no top-level field restriction. */
  unrestrictedRows(source: string): Finding[] {
    return [...this.calls(source)]
      .filter(({ model, argument }) => this.secret.has(model) && !restrictsFields(argument))
      .map(({ line, model }) => ({ line, model }));
  }

  /** Rule 2: relations to secret models included or selected whole. */
  wholeSecretRelations(source: string): Finding[] {
    const findings: Finding[] = [];
    for (const { model, line, argument } of this.calls(source)) {
      for (const { key, value } of entries(argument)) {
        if (key !== 'select' && key !== 'include') continue;
        for (const relation of this.wholeRelations(model, value)) {
          findings.push({ line, model: relation });
        }
      }
    }
    return findings;
  }

  /** `Model.relation` paths in a selection object that load a secret model whole. */
  private wholeRelations(model: string, selection: string): string[] {
    const fields = this.schema.get(model);
    if (!fields) return [];
    return entries(selection).flatMap(({ key, value }) => {
      const target = fields.get(key);
      if (key === '_count' || !target || !this.schema.has(target)) return [];
      const path = `${model}.${key}`;
      if (value === 'true') return this.secret.has(target) ? [path] : [];
      if (!value.startsWith('{')) return [];
      const nested = entries(value);
      const select = nested.find((entry) => entry.key === 'select');
      if (select) return this.wholeRelations(target, select.value);
      const own = this.secret.has(target) && !nested.some((entry) => entry.key === 'omit');
      const include = nested.find((entry) => entry.key === 'include');
      return [
        ...(own ? [path] : []),
        ...(include ? this.wholeRelations(target, include.value) : []),
      ];
    });
  }
}

const guard = new ResponseGuard(
  parseSchema(readFileSync(join(repoRoot, 'prisma/schema.prisma'), 'utf8'))
);

/**
 * Reviewed reads of whole secret-model rows, per file and model. Each is read to verify a
 * credential, or mapped to an explicit response shape, before anything leaves the server.
 * Nothing under `src/server` may appear here with the `User` model.
 */
const REVIEWED_ROW_READS: Record<string, Record<string, number>> = {
  'src/app/api/platform/mfa/route.ts': { PlatformSession: 1 },
  'src/app/api/restaurant/cameras/[cameraId]/stream/route.ts': { RestaurantCameraGateway: 1 },
  'src/app/api/sso/oidc/[connectionId]/callback/route.ts': { OrganizationIdentityConnection: 1 },
  'src/app/api/sso/saml/[connectionId]/callback/route.ts': { OrganizationIdentityConnection: 1 },
  'src/lib/ai/tools/people.ts': { User: 2 },
  'src/lib/api-auth.ts': { ApiToken: 2 },
  'src/lib/auth.ts': { TenantSsoTicket: 1 },
  'src/lib/auth/login-intent.ts': { PendingLoginIntent: 1 },
  'src/lib/cameras/cameras.ts': { RestaurantCameraGateway: 4 },
  'src/lib/cameras/privacy.ts': { CameraGateway: 1, RestaurantCameraGateway: 1 },
  'src/lib/demo/seed-personas.ts': { User: 1 },
  'src/lib/member-invitation.ts': { User: 2 },
  'src/lib/pharmacy/basket-workflow.ts': { RestaurantOperatorCredential: 1 },
  'src/lib/pharmacy/controlled-restoration-authorization.ts': {
    RestaurantOperatorCredential: 1,
    User: 1,
  },
  'src/lib/pharmacy/counter-line-approval.ts': { RestaurantOperatorCredential: 2, User: 3 },
  'src/lib/pharmacy/customer-ordering.ts': { User: 1 },
  'src/lib/pharmacy/goods-receipt.ts': { RestaurantOperatorCredential: 1 },
  'src/lib/pharmacy/hosted-receipt-service.ts': { PharmacyHostedReceipt: 1 },
  'src/lib/pharmacy/offline-devices.ts': { PharmacyRegisteredDevice: 4 },
  'src/lib/pharmacy/owner-data-export-pin.ts': { RestaurantOperatorCredential: 1 },
  'src/lib/pharmacy/purchase-approval.ts': { RestaurantOperatorCredential: 1 },
  'src/lib/pharmacy/refill-subscriptions.ts': { RestaurantOperatorCredential: 1 },
  'src/lib/pharmacy/refund-authorization.ts': { RestaurantOperatorCredential: 1 },
  'src/lib/pharmacy/sop-adapter.ts': { User: 1 },
  'src/lib/pharmacy/supplier-action-links.ts': { PharmacySupplierActionLink: 2 },
  'src/lib/pharmacy/voucher-controls.ts': { User: 1 },
  'src/lib/pharmacy/write-off-witness.ts': { RestaurantOperatorCredential: 1, User: 1 },
  'src/lib/platform/auth.ts': { PlatformSession: 3, PlatformUser: 1 },
  'src/lib/platform/commands.ts': {
    OrganizationEmailSettings: 1,
    OrganizationIdentityConnection: 5,
    OrganizationScimToken: 2,
    PlatformUser: 4,
    User: 3,
  },
  'src/lib/platform/jobs.ts': { OrganizationIdentityConnection: 1 },
  'src/lib/restaurant/credential-lifecycle.ts': { RestaurantOperatorCredential: 4 },
  'src/lib/restaurant/devices.ts': { RestaurantRegisteredDevice: 4 },
  'src/lib/restaurant/notification-webhook.ts': { RestaurantNotificationWebhook: 1 },
  'src/lib/restaurant/terminal-auth.ts': {
    RestaurantOperatorCredential: 1,
    RestaurantRegisteredDevice: 2,
  },
  'src/lib/restaurant/terminal-session.ts': { RestaurantTerminalSession: 6 },
  'src/lib/restaurant/wallet/enrollment.ts': { WalletEnrollmentAttempt: 2 },
  'src/lib/sso.ts': { OrganizationIdentityConnection: 1, TenantSsoTicket: 1, User: 2 },
  'src/server/routers/email.ts': { MailboxOAuthState: 1 },
  'src/server/routers/invitations.ts': { Invitation: 1 },
  'src/server/routers/organization-admin.ts': { OrganizationEmailSettings: 1 },
  'src/server/routers/password-reset.ts': { PasswordResetToken: 1 },
  'src/server/routers/pharmacy-cameras.ts': { CameraGateway: 1 },
  'src/server/routers/pharmacy-offline.ts': { PharmacyRegisteredDevice: 1 },
  'src/server/routers/pharmacy-reports.ts': { RestaurantOperatorCredential: 1 },
  'src/server/routers/pharmacy-safety.ts': { RestaurantOperatorCredential: 1 },
  'src/server/routers/pharmacy-sales.ts': { RestaurantOperatorCredential: 1 },
  'src/server/routers/restaurant-cameras.ts': { RestaurantCameraGateway: 4 },
  'src/server/routers/restaurant-devices.ts': { RestaurantRegisteredDevice: 3 },
};

/** Reviewed whole secret relations, per file and `Model.relation`. Same ratchet as above. */
const REVIEWED_RELATION_READS: Record<string, Record<string, number>> = {
  'src/app/api/pharmacy/cameras/[cameraId]/stream/route.ts': { 'Camera.gateway': 1 },
  'src/app/platform/(console)/organizations/[id]/page.tsx': {
    'Organization.emailSettings': 1,
    'Organization.identityConnections': 1,
    'Organization.scimTokens': 1,
  },
  'src/lib/auth.ts': { 'TenantSsoTicket.user': 1 },
  'src/lib/cameras/evidence.ts': { 'Camera.gateway': 1 },
  'src/lib/pharmacy/controlled-register.ts': { 'RestaurantStaffProfile.user': 1 },
  'src/lib/pharmacy/controlled-restoration-authorization.ts': { 'RestaurantStaffProfile.user': 1 },
  'src/lib/pharmacy/counter-line-approval.ts': { 'RestaurantStaffProfile.user': 3 },
  'src/lib/pharmacy/goods-receipt.ts': { 'RestaurantStaffProfile.user': 1 },
  'src/lib/pharmacy/refill-subscriptions.ts': { 'RestaurantStaffProfile.user': 1 },
  'src/lib/pharmacy/sop-adapter.ts': { 'RestaurantStaffProfile.user': 1 },
  'src/lib/platform/commands.ts': { 'Organization.users': 1 },
  'src/server/routers/pharmacy-cameras.ts': { 'Camera.gateway': 1 },
  'src/server/routers/pharmacy-safety.ts': { 'RestaurantStaffProfile.user': 1 },
  'src/server/routers/pharmacy-sales.ts': { 'RestaurantStaffProfile.user': 1 },
};

function tally(findings: (Finding & { path: string })[]) {
  const found: Record<string, Record<string, number>> = {};
  for (const { path, model } of findings) {
    const byModel = (found[path] ??= {});
    byModel[model] = (byModel[model] ?? 0) + 1;
  }
  return found;
}

function scan(rule: (source: string) => Finding[]) {
  return SCANNED_ROOTS.flatMap((root) => sourceFiles(join(repoRoot, root))).flatMap((path) =>
    rule(readFileSync(path, 'utf8')).map((finding) => ({
      ...finding,
      path: relative(repoRoot, path).split('\\').join('/'),
    }))
  );
}

const lines = (findings: Finding[]) => findings.map(({ line }) => line);

describe('secret-row response guard (DEV-828, DEV-848)', () => {
  it('derives the secret-holding models from the schema', () => {
    expect(guard.secretModelNames).toEqual(
      expect.arrayContaining([
        'User',
        'ApiToken',
        'OrganizationScimToken',
        'PharmacySupplierActionLink',
        'PasswordResetToken',
        'Invitation',
        'PlatformUser',
        'PlatformSession',
        'Webhook',
        'OrganizationIdentityConnection',
      ])
    );
    // Content and payload hashes are integrity checks, not secrets.
    expect(guard.secretModelNames).not.toContain('PharmacyDailyClose');
    expect(guard.secretModelNames).not.toContain('RestaurantPromotionVersion');
    expect(guard.secretModelNames).not.toContain('Organization');
  });

  it('flags the leaking row shapes', () => {
    // The pre-fix `team.updateProfile` / `organizationAdmin.updateMember` shape.
    expect(
      lines(
        guard.unrestrictedRows(`
      return ctx.db.user.update({
        where: { id },
        data: input,
      });`)
      )
    ).toEqual([2]);
    // The pre-fix `team.layOffMember` shape: kept in a variable, returned later.
    expect(
      lines(
        guard.unrestrictedRows(`
      const updated = await tx.user.update({ where: { id }, data: { status: 'INACTIVE' } });
      return updated;`)
      )
    ).toEqual([2]);
    expect(
      lines(guard.unrestrictedRows(`const u = await ctx.db.user.findUnique({ where });`))
    ).toEqual([1]);
    // A select nested in an include does not restrict the User scalars.
    expect(
      lines(
        guard.unrestrictedRows(
          `return db.user.findFirst({ where, include: { team: { select: { id: true } } } });`
        )
      )
    ).toEqual([1]);
    // An argument passed by reference cannot be checked, so it is not trusted.
    expect(lines(guard.unrestrictedRows(`return ctx.db.user.update(args);`))).toEqual([1]);
    // A transaction whose result is kept.
    expect(
      lines(
        guard.unrestrictedRows(`
      const [user] = await ctx.db.$transaction([
        ctx.db.user.update({ where, data }),
      ]);`)
      )
    ).toEqual([3]);
  });

  it('flags whole rows of other secret-holding models (DEV-848)', () => {
    // The pre-fix `apiTokens.list`, `apiTokens.revoke`, `revokeScimToken` and supplier-link
    // revoke shapes.
    expect(
      guard.unrestrictedRows(`
      return ctx.db.apiToken.findMany({
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, name: true } } },
      });
      const deleted = await ctx.db.apiToken.delete({ where: { id: input.id } });
      const saved = await ctx.db.organizationScimToken.update({ where, data });
      return ctx.db.pharmacySupplierActionLink.update({ where, data });`)
    ).toEqual([
      { line: 2, model: 'ApiToken' },
      { line: 6, model: 'ApiToken' },
      { line: 7, model: 'OrganizationScimToken' },
      { line: 8, model: 'PharmacySupplierActionLink' },
    ]);
    // Models without a secret column are not rows of concern.
    expect(guard.unrestrictedRows(`return ctx.db.task.findMany({ where });`)).toEqual([]);
  });

  it('accepts restricted or discarded calls', () => {
    expect(
      guard.unrestrictedRows(`
      return ctx.db.user.update({
        where: { id },
        data: input,
        select: { id: true, name: true },
      });
      const user = await tx.user.findUnique({ where, omit: { password: true } });
      const other = await tx.user.findFirst({ where, select });
      const token = await ctx.db.apiToken.delete({ where, select: API_TOKEN_FIELDS });
      await ctx.db.user.update({ where, data: { tokenVersion: { increment: 1 } } });
      await ctx.db.$transaction([
        ctx.db.user.update({ where, data }),
        ctx.db.twoFactorRecoveryCode.deleteMany({ where }),
      ]);`)
    ).toEqual([]);
    // A key named `select` inside a string or nested object does not count.
    expect(
      lines(guard.unrestrictedRows(`return db.user.findFirst({ where: { name: 'select:' } });`))
    ).toEqual([1]);
  });

  it('flags a secret relation included or selected whole (DEV-848)', () => {
    expect(
      guard.wholeSecretRelations(`
      return ctx.db.apiToken.findMany({ include: { user: true } });
      return ctx.db.apiToken.findMany({ select: { id: true, user: true } });
      return ctx.db.apiToken.findMany({ include: { user: { include: { apiTokens: true } } } });
      return ctx.db.apiToken.findMany({ include: { user: { where: { status: 'ACTIVE' } } } });`)
    ).toEqual([
      { line: 2, model: 'ApiToken.user' },
      { line: 3, model: 'ApiToken.user' },
      { line: 4, model: 'ApiToken.user' },
      { line: 4, model: 'User.apiTokens' },
      { line: 5, model: 'ApiToken.user' },
    ]);
  });

  it('accepts secret relations with their own field selection', () => {
    expect(
      guard.wholeSecretRelations(`
      return ctx.db.apiToken.findMany({ include: { user: { select: { id: true } } } });
      return ctx.db.apiToken.findMany({ include: { user: { omit: { password: true } } } });
      return ctx.db.apiToken.findMany({ select: { user: { select: { name: true } } } });
      return ctx.db.user.findMany({ select: { id: true, _count: { select: { apiTokens: true } } } });
      return ctx.db.apiToken.findMany({ where: { user: { is: { status: 'ACTIVE' } } } });
      await ctx.db.apiToken.findMany({ include: { user: true } });`)
    ).toEqual([]);
  });

  it('finds no tRPC code under src/server that keeps an unrestricted User row', () => {
    const offenders = scan((source) => guard.unrestrictedRows(source))
      .filter(({ path, model }) => path.startsWith('src/server/') && model === 'User')
      .map(({ path, line }) => `${path}:${line}`);
    expect(offenders).toEqual([]);
  });

  it('finds no unreviewed whole secret-model row in src/server, src/lib or src/app', () => {
    expect(tally(scan((source) => guard.unrestrictedRows(source)))).toEqual(REVIEWED_ROW_READS);
    expect(
      Object.entries(REVIEWED_ROW_READS).filter(
        ([path, models]) => path.startsWith('src/server/') && 'User' in models
      )
    ).toEqual([]);
  });

  it('finds no unreviewed whole secret relation in src/server, src/lib or src/app', () => {
    expect(tally(scan((source) => guard.wholeSecretRelations(source)))).toEqual(
      REVIEWED_RELATION_READS
    );
  });
});
