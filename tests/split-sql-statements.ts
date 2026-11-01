export type SqlRunner = {
  $queryRawUnsafe: (query: string) => Promise<unknown>;
  $executeRawUnsafe: (query: string) => Promise<unknown>;
};

/** Splits a migration file on semicolons that sit outside dollar quotes and comments. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let dollar: string | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    if (!dollar && sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index);
      const next = end === -1 ? sql.length : end + 1;
      current += sql.slice(index, next);
      index = next - 1;
      continue;
    }
    if (sql[index] === '$') {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index));
      if (match) {
        const tag = match[0];
        if (dollar === tag) dollar = null;
        else if (!dollar) dollar = tag;
        current += tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (!dollar && sql[index] === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }
    current += sql[index];
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

export async function runMigrationSql(client: SqlRunner, sql: string): Promise<void> {
  for (const statement of splitSqlStatements(sql)) {
    const body = statement.replace(/^(?:\s*--[^\n]*\n)+/, '').trim();
    if (/^SELECT\b/i.test(body)) await client.$queryRawUnsafe(statement);
    else await client.$executeRawUnsafe(statement);
  }
}
