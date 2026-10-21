import { describe, expect, it } from 'vitest';

import type { DeviceTrustState } from './devices';
import {
  SESSION_IDLE_TIMEOUT_MS,
  TERMINAL_SESSION_TOKEN_PREFIX,
  TerminalSessionError,
  assertOperatorBindable,
  evaluateTerminalSession,
  generateTerminalSessionToken,
  hashTerminalSessionToken,
  isTerminalSessionTokenFormat,
  terminalSessionState,
  type TerminalSessionSnapshot,
} from './terminal-session';

const now = new Date('2026-08-18T12:00:00.000Z');

const activeDevice: DeviceTrustState & { id: string } = {
  id: 'dev_1',
  status: 'ACTIVE',
  revokedAt: null,
};

function session(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    deviceId: 'dev_1',
    activeStaffProfileId: null,
    endedAt: null,
    lastActivityAt: now,
    ...overrides,
  };
}

describe('terminal session token primitives', () => {
  it('hashes deterministically and mints a matching, prefixed token', () => {
    const { token, tokenHash } = generateTerminalSessionToken();
    expect(token.startsWith(TERMINAL_SESSION_TOKEN_PREFIX)).toBe(true);
    expect(tokenHash).toBe(hashTerminalSessionToken(token));
    expect(hashTerminalSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(isTerminalSessionTokenFormat(token)).toBe(true);
    expect(isTerminalSessionTokenFormat('rdk_device')).toBe(false);
  });
});

describe('terminalSessionState', () => {
  it('is LOCKED with no operator and UNLOCKED once bound', () => {
    expect(terminalSessionState({ activeStaffProfileId: null })).toBe('LOCKED');
    expect(terminalSessionState({ activeStaffProfileId: 'staff_1' })).toBe('UNLOCKED');
  });
});

describe('evaluateTerminalSession (C5 per-call revalidation)', () => {
  it('accepts a live session, reporting its lock state', () => {
    expect(evaluateTerminalSession(session(), activeDevice, now)).toEqual({
      ok: true,
      state: 'LOCKED',
    });
    expect(
      evaluateTerminalSession(session({ activeStaffProfileId: 'staff_1' }), activeDevice, now)
    ).toEqual({ ok: true, state: 'UNLOCKED' });
  });

  it('rejects when the session token belongs to a different device', () => {
    expect(evaluateTerminalSession(session({ deviceId: 'other' }), activeDevice, now)).toEqual({
      ok: false,
      reason: 'DEVICE_MISMATCH',
    });
  });

  it('rejects mid-session when the device is revoked (no trust cache)', () => {
    // Same still-"valid" session row, but a FRESH device read shows REVOKED.
    const revokedDevice = { id: 'dev_1', status: 'REVOKED' as const, revokedAt: now };
    expect(evaluateTerminalSession(session(), revokedDevice, now)).toEqual({
      ok: false,
      reason: 'DEVICE_REVOKED',
    });
  });

  it('rejects replay of an ended session (post-revocation replay rejection)', () => {
    expect(
      evaluateTerminalSession(
        session({ endedAt: new Date(now.getTime() - 1000) }),
        activeDevice,
        now
      )
    ).toEqual({ ok: false, reason: 'SESSION_ENDED' });
  });

  it('rejects a session idled past the timeout, using server time only', () => {
    const idle = session({ lastActivityAt: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS - 1) });
    expect(evaluateTerminalSession(idle, activeDevice, now)).toEqual({
      ok: false,
      reason: 'SESSION_EXPIRED',
    });
    // Exactly at the boundary is still valid.
    const atBoundary = session({
      lastActivityAt: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS),
    });
    expect(evaluateTerminalSession(atBoundary, activeDevice, now).ok).toBe(true);
  });

  it('prioritises a device mismatch over the device-usable check', () => {
    const revokedOther = { id: 'dev_1', status: 'REVOKED' as const, revokedAt: now };
    expect(evaluateTerminalSession(session({ deviceId: 'mismatch' }), revokedOther, now).ok).toBe(
      false
    );
  });
});

describe('assertOperatorBindable (C6 switch guard)', () => {
  it('allows binding an operator on a live session', () => {
    expect(() => assertOperatorBindable({ endedAt: null })).not.toThrow();
  });

  it('refuses to bind or switch an operator on an ended session', () => {
    expect(() => assertOperatorBindable({ endedAt: now })).toThrow(TerminalSessionError);
  });
});
