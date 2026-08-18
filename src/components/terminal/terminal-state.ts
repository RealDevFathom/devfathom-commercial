export type TerminalFailureKind =
  'network' | 'unauthorized' | 'forbidden' | 'locked' | 'revoked' | 'error';

export type TerminalFailure = {
  kind: TerminalFailureKind;
  title: string;
  message: string;
  reset: 'none' | 'session' | 'device';
};

export function sanitizePin(value: string): string {
  return value.replace(/\D/g, '').slice(0, 8);
}

export function isValidPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

export function validateOperatorCredential(staffProfileId: string, pin: string): string | null {
  if (staffProfileId.trim().length === 0) return 'Enter the incoming operator profile ID.';
  if (!isValidPin(pin)) return 'PIN must contain 4–8 digits.';
  return null;
}

export function validateCoAuthorization(input: {
  actingStaffProfileId: string;
  approvingStaffProfileId: string;
  pin: string;
  capability: string;
  reason: string;
  targetType: string;
  targetId: string;
}): string | null {
  const acting = input.actingStaffProfileId.trim();
  const approving = input.approvingStaffProfileId.trim();
  if (approving.length === 0) return 'Enter the approving manager profile ID.';
  if (acting === approving) return 'Approving manager must differ from the acting operator.';
  if (!isValidPin(input.pin)) return 'Manager PIN must contain 4–8 digits.';
  if (input.capability.trim().length === 0) return 'Enter the capability or action.';
  if (input.reason.trim().length === 0) return 'Enter the approval reason.';
  if ((input.targetType.trim().length === 0) !== (input.targetId.trim().length === 0)) {
    return 'Enter both target type and target ID, or leave both empty.';
  }
  return null;
}

function retryMessage(retryAfter: string | null): string {
  const seconds = Number.parseInt(retryAfter ?? '', 10);
  return Number.isFinite(seconds) && seconds > 0
    ? `Server requires a ${seconds}-second wait before another attempt.`
    : 'Wait before another attempt. The server controls when the credential can be retried.';
}

export function classifyTerminalFailure(
  status: number,
  serverMessage?: string,
  retryAfter: string | null = null
): TerminalFailure {
  const message = serverMessage?.toLowerCase() ?? '';

  if (status === 0) {
    return {
      kind: 'network',
      title: 'Connection degraded',
      message: 'Server could not be reached. Last confirmed terminal state remains shown.',
      reset: 'none',
    };
  }
  if (status === 403 && message.includes('revoked')) {
    return {
      kind: 'revoked',
      title: 'Device revoked',
      message: 'This device can no longer operate. Request a new device enrollment.',
      reset: 'device',
    };
  }
  if (status === 401 && message.includes('session')) {
    return {
      kind: 'unauthorized',
      title: 'Session ended',
      message: 'Re-establish the device session before continuing.',
      reset: 'session',
    };
  }
  if (status === 401 && message.includes('device')) {
    return {
      kind: 'unauthorized',
      title: 'Device not authorized',
      message: 'Enter a current enrollment secret issued for this terminal.',
      reset: 'device',
    };
  }
  if (status === 401) {
    return {
      kind: 'unauthorized',
      title: 'Credential refused',
      message: 'Check the staff profile ID and PIN, then try again.',
      reset: 'none',
    };
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      title: 'Permission denied',
      message: 'This terminal is not permitted to complete that request.',
      reset: 'none',
    };
  }
  if (status === 423 || status === 429) {
    return {
      kind: 'locked',
      title: status === 423 ? 'Credential locked' : 'Attempts limited',
      message: retryMessage(retryAfter),
      reset: 'none',
    };
  }
  if (status === 409) {
    return {
      kind: 'error',
      title: 'Terminal state changed',
      message: 'Refresh server status, then use the action available for the current state.',
      reset: 'none',
    };
  }
  if (status === 400) {
    return {
      kind: 'error',
      title: 'Request not accepted',
      message: 'Review the entered identities and approval evidence, then try again.',
      reset: 'none',
    };
  }
  return {
    kind: 'error',
    title: 'Terminal request failed',
    message: 'No terminal state changed. Try again or ask an administrator to check the service.',
    reset: 'none',
  };
}
