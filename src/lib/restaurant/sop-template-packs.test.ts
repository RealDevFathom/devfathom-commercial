/**
 * SOP-1 / WHA-224 — pure-function coverage for the pack catalogue, the role-key
 * normaliser, and the assignee-target projection. These need no database, so they
 * still guard the invariants when the suite runs without PostgreSQL (where the
 * `.db.test.ts` companion skips).
 */
import { describe, expect, it } from 'vitest';

import { normalizeJobRoleKey, DEFAULT_JOB_ROLES } from './job-roles';
import { SOP_TEMPLATE_PACKS, findSopPack } from './sop-template-packs';
import { assigneeTargetColumns, assigneeTargetOf, occurrenceOwnerColumns } from './sop-assignment';

describe('SOP starter packs', () => {
  it('ships exactly nine packs with unique keys and names', () => {
    expect(SOP_TEMPLATE_PACKS).toHaveLength(9);
    expect(new Set(SOP_TEMPLATE_PACKS.map((pack) => pack.key)).size).toBe(9);
    expect(new Set(SOP_TEMPLATE_PACKS.map((pack) => pack.name)).size).toBe(9);
  });

  it('gives every pack steps and a resolvable default job role', () => {
    const roleKeys = new Set(DEFAULT_JOB_ROLES.map((role) => role.key));
    for (const pack of SOP_TEMPLATE_PACKS) {
      expect(pack.steps.length).toBeGreaterThan(0);
      expect(pack.steps.every((step) => step.title.trim().length > 0)).toBe(true);
      // A pack whose default role does not exist would install as unassignable.
      expect(roleKeys.has(pack.defaultJobRoleKey)).toBe(true);
    }
  });

  it('keeps every suggested recurrence internally consistent', () => {
    for (const pack of SOP_TEMPLATE_PACKS) {
      const rule = pack.suggestedRecurrence;
      expect(rule.interval).toBeGreaterThanOrEqual(1);
      expect(rule.dueTimeMinutes).toBeGreaterThanOrEqual(0);
      expect(rule.dueTimeMinutes).toBeLessThan(1440);
      expect(rule.windowMinutes).toBeGreaterThan(0);
      expect(rule.graceMinutes).toBeGreaterThanOrEqual(0);
      // WEEKLY needs days; MONTHLY needs a month day. Anything else must not carry
      // the field, or the generator would silently ignore a schedule the operator
      // believes they configured.
      if (rule.frequency === 'WEEKLY') expect(rule.daysOfWeek.length).toBeGreaterThan(0);
      else expect(rule.daysOfWeek).toEqual([]);
      if (rule.frequency === 'MONTHLY') expect(rule.monthDay).not.toBeNull();
      else expect(rule.monthDay).toBeNull();
    }
  });

  it('looks a pack up by key and reports an unknown one as undefined', () => {
    expect(findSopPack('front-of-house-opening')?.name).toBe('Front of house — opening');
    expect(findSopPack('no-such-pack')).toBeUndefined();
  });
});

describe('normalizeJobRoleKey', () => {
  it('folds case, whitespace and separators to one canonical key', () => {
    expect(normalizeJobRoleKey(' Barista ')).toBe('barista');
    expect(normalizeJobRoleKey('BARISTA')).toBe('barista');
    expect(normalizeJobRoleKey('Kitchen Porter')).toBe('kitchen-porter');
    expect(normalizeJobRoleKey('shift__lead')).toBe('shift-lead');
    expect(normalizeJobRoleKey('--manager--')).toBe('manager');
  });

  it('folds an all-punctuation key to empty so the caller can reject it', () => {
    expect(normalizeJobRoleKey('   ')).toBe('');
    expect(normalizeJobRoleKey('///')).toBe('');
  });
});

describe('assignee target projection', () => {
  it('sets exactly the column matching the discriminant', () => {
    expect(assigneeTargetColumns({ type: 'person', staffProfileId: 's1' })).toEqual({
      assigneeTargetType: 'PERSON',
      assigneeStaffProfileId: 's1',
      assigneeJobRoleId: null,
    });
    expect(assigneeTargetColumns({ type: 'role', jobRoleId: 'r1' })).toEqual({
      assigneeTargetType: 'ROLE',
      assigneeStaffProfileId: null,
      assigneeJobRoleId: 'r1',
    });
  });

  it('round-trips a persisted row back to a target', () => {
    for (const target of [
      { type: 'person', staffProfileId: 's1' },
      { type: 'role', jobRoleId: 'r1' },
    ] as const) {
      expect(assigneeTargetOf(assigneeTargetColumns(target))).toEqual(target);
    }
  });

  it('throws rather than guessing when a row is incoherent', () => {
    expect(() =>
      assigneeTargetOf({
        assigneeTargetType: 'ROLE',
        assigneeStaffProfileId: null,
        assigneeJobRoleId: null,
      })
    ).toThrow(/missing its job role/);
    expect(() =>
      assigneeTargetOf({
        assigneeTargetType: 'PERSON',
        assigneeStaffProfileId: null,
        assigneeJobRoleId: 'r1',
      })
    ).toThrow(/missing its staff profile/);
  });

  it('maps a target onto the occurrence owner columns, never both', () => {
    expect(
      occurrenceOwnerColumns({
        assigneeTargetType: 'PERSON',
        assigneeStaffProfileId: 's1',
        assigneeJobRoleId: null,
      })
    ).toEqual({ assignedStaffProfileId: 's1', poolJobRoleId: null });

    expect(
      occurrenceOwnerColumns({
        assigneeTargetType: 'ROLE',
        assigneeStaffProfileId: null,
        assigneeJobRoleId: 'r1',
      })
    ).toEqual({ assignedStaffProfileId: null, poolJobRoleId: 'r1' });
  });
});
