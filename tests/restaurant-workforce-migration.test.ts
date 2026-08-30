import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'prisma/migrations/20260830180000_restaurant_workforce_v1/migration.sql'),
  'utf8'
);

describe('restaurant workforce migration security contract', () => {
  it('forces tenant RLS for every workforce table', () => {
    expect(migration).toContain('ALTER TABLE "restaurant_shift_breaks" FORCE ROW LEVEL SECURITY');
    for (const table of [
      'restaurant_shift_swap_requests',
      'restaurant_shift_swap_decisions',
      'restaurant_shift_events',
      'restaurant_time_adjustments',
      'restaurant_workforce_commands',
    ]) {
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY tenant_select');
    expect(migration).toContain('CREATE POLICY tenant_insert');
  });

  it('binds every workforce child to its tenant parent', () => {
    for (const constraint of [
      'tenant_shift_break_shift_fk',
      'tenant_shift_swap_shift_fk',
      'tenant_shift_swap_requester_fk',
      'tenant_shift_swap_replacement_fk',
      'tenant_shift_swap_decision_request_fk',
      'tenant_shift_event_shift_fk',
      'tenant_time_adjustment_shift_fk',
      'tenant_workforce_command_shift_fk',
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
  });

  it('makes history and raw time observations append-only', () => {
    expect(migration).toContain('restaurant workforce history is append-only');
    expect(migration).toContain('restaurant shift time observations are append-only');
    expect(migration).toContain('restaurant break time observations are append-only');
  });
});
