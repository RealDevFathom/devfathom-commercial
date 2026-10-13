// SYNTHETIC TEST PREMISES ONLY. Never enrich a real capture or saved catalog.
export function enforced(table, fk, index = 0) {
  return {
    ...fk,
    name: fk.name ?? `${table}_${index}_fkey`,
    parentSchema: 'public',
    deferrable: false,
    deferred: false,
    enforcement: [
      [table, 'RI_FKey_check_ins'],
      [table, 'RI_FKey_check_upd'],
      [fk.table, 'RI_FKey_restrict_del'],
      [fk.table, 'RI_FKey_cascade_upd'],
    ].map(([table, func]) => ({
      table,
      schema: 'pg_catalog',
      function: func,
      enabled: 'O',
      internal: true,
      deferrable: false,
      deferred: false,
    })),
  };
}
export function withEnforcement(tables) {
  for (const t of tables) t.foreignKeys = t.foreignKeys.map((fk, i) => enforced(t.name, fk, i));
  return tables;
}
