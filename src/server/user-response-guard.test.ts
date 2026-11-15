/**
 * DEV-828: tRPC procedures returned whole `User` rows (`team.updateProfile`,
 * `team.layOffMember`, `organizationAdmin.updateMember`). A User row carries the
 * password verifier and the base32 TOTP seed, so any caller that saw the response
 * held the account's second factor.
 *
 * This source-level guard fails when code under `src/server` keeps the result of a
 * `user` delegate query or write that has no top-level `select` or `omit`. A call
 * whose result is discarded (a bare `await` statement, or an element of an awaited
 * `$transaction([...])` whose result is discarded) is allowed, because nothing can
 * reach a response.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const serverRoot = __dirname;

const USER_CALL =
  /\.user\.(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|create|createManyAndReturn|update|updateManyAndReturn|upsert|delete)\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Index just past the `)` closing the call whose `(` ends at `open`. */
function closeParen(source: string, open: number): number {
  let depth = 1;
  let i = open;
  while (depth > 0 && i < source.length) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    i++;
  }
  return i;
}

/** True when the call's argument object has a top-level `select` or `omit` key. */
function restrictsFields(argument: string): boolean {
  let depth = 0;
  for (let i = 0; i < argument.length; i++) {
    const ch = argument[i]!;
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    else if (depth === 1 && !/[\w$]/.test(argument[i - 1] ?? '')) {
      if (/^(select|omit)\s*[:,}]/.test(argument.slice(i))) return true;
    }
  }
  return false;
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

/** Line numbers of `user` calls whose full row may reach a caller. */
function unrestrictedUserResults(source: string): number[] {
  const lines: number[] = [];
  for (const match of source.matchAll(USER_CALL)) {
    const open = match.index + match[0].length;
    const argument = source.slice(open, closeParen(source, open) - 1);
    if (restrictsFields(argument)) continue;
    if (resultDiscarded(source, match.index)) continue;
    lines.push(source.slice(0, match.index).split('\n').length);
  }
  return lines;
}

describe('user-row response guard (DEV-828)', () => {
  it('flags the leaking shapes', () => {
    // The pre-fix `team.updateProfile` / `organizationAdmin.updateMember` shape.
    expect(
      unrestrictedUserResults(`
      return ctx.db.user.update({
        where: { id },
        data: input,
      });`)
    ).toEqual([2]);
    // The pre-fix `team.layOffMember` shape: kept in a variable, returned later.
    expect(
      unrestrictedUserResults(`
      const updated = await tx.user.update({ where: { id }, data: { status: 'INACTIVE' } });
      return updated;`)
    ).toEqual([2]);
    expect(unrestrictedUserResults(`const u = await ctx.db.user.findUnique({ where });`)).toEqual([
      1,
    ]);
    // A select nested in an include does not restrict the User scalars.
    expect(
      unrestrictedUserResults(
        `return db.user.findFirst({ where, include: { team: { select: { id: true } } } });`
      )
    ).toEqual([1]);
    // An argument passed by reference cannot be checked, so it is not trusted.
    expect(unrestrictedUserResults(`return ctx.db.user.update(args);`)).toEqual([1]);
    // A transaction whose result is kept.
    expect(
      unrestrictedUserResults(`
      const [user] = await ctx.db.$transaction([
        ctx.db.user.update({ where, data }),
      ]);`)
    ).toEqual([3]);
  });

  it('accepts restricted or discarded calls', () => {
    expect(
      unrestrictedUserResults(`
      return ctx.db.user.update({
        where: { id },
        data: input,
        select: { id: true, name: true },
      });
      const user = await tx.user.findUnique({ where, omit: { password: true } });
      const other = await tx.user.findFirst({ where, select });
      await ctx.db.user.update({ where, data: { tokenVersion: { increment: 1 } } });
      await ctx.db.$transaction([
        ctx.db.user.update({ where, data }),
        ctx.db.twoFactorRecoveryCode.deleteMany({ where }),
      ]);`)
    ).toEqual([]);
  });

  it('finds no tRPC server code that keeps an unrestricted User row', () => {
    const offenders = sourceFiles(serverRoot).flatMap((path) =>
      unrestrictedUserResults(readFileSync(path, 'utf8')).map(
        (line) => `${relative(serverRoot, path)}:${line}`
      )
    );
    expect(offenders).toEqual([]);
  });
});
