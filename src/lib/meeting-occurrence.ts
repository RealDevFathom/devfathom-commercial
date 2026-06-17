/**
 * Helpers for computing meeting occurrence times + punctuality.
 *
 * Background: recurring meetings are stored as a single Meeting row whose
 * `startTime`/`endTime` are the ORIGINAL occurrence. The actual occurrence
 * the user joined is computed on the fly from the recurrence pattern.
 *
 * Without this, joining today's standup that originally started yesterday
 * gets reported as "1440 minutes late". With this, it correctly reports
 * the offset from today's occurrence.
 */

/**
 * "On time" window — a user who joined within this many minutes of the
 * occurrence start is considered on time. Anything more is "X min late".
 */
export const ON_TIME_THRESHOLD_MINUTES = 10;

/**
 * Given a meeting's original start, recurrence pattern, and a join timestamp,
 * return the start time of the occurrence the user actually joined.
 *
 * For non-recurring meetings, this is just the original start.
 * For recurring meetings, this is the most recent occurrence whose start
 * is <= joinedAt. (If the user joined before the original start somehow,
 * we return the original start.)
 */
export function computeOccurrenceStart(
  originalStart: Date,
  recurrence: string | null,
  joinedAt: Date,
): Date {
  if (!recurrence) return originalStart;
  if (joinedAt.getTime() <= originalStart.getTime()) return originalStart;

  // Walk forward in steps of the recurrence interval, finding the latest
  // occurrence whose start is still ≤ joinedAt.
  const current = new Date(originalStart);
  let lastValid = new Date(originalStart);

  for (let i = 0; i < 5000; i++) {
    if (current.getTime() > joinedAt.getTime()) break;
    lastValid = new Date(current);

    switch (recurrence) {
      case 'daily':
        current.setDate(current.getDate() + 1);
        break;
      case 'weekly':
        current.setDate(current.getDate() + 7);
        break;
      case 'biweekly':
        current.setDate(current.getDate() + 14);
        break;
      case 'monthly':
        current.setMonth(current.getMonth() + 1);
        break;
      default:
        return originalStart;
    }
  }

  return lastValid;
}

/**
 * Find the "currently relevant" occurrence of a meeting — the one the user
 * would be joining if they clicked Join right now.
 *
 * Semantics:
 * - If the meeting is currently live, return that occurrence
 * - If we're in a gap, return whichever is closest (prev or next)
 * - For non-recurring meetings, just returns the meeting's own start/end
 */
export function findRelevantOccurrence(
  originalStart: Date,
  originalEnd: Date,
  recurrence: string | null,
  now: Date,
): { start: Date; end: Date } {
  if (!recurrence) {
    return { start: new Date(originalStart), end: new Date(originalEnd) };
  }

  const duration = originalEnd.getTime() - originalStart.getTime();
  const current = new Date(originalStart);
  let prev: { start: Date; end: Date } | null = null;

  for (let i = 0; i < 5000; i++) {
    const start = new Date(current);
    const end = new Date(current.getTime() + duration);

    // Currently live — this is the one
    if (start.getTime() <= now.getTime() && now.getTime() < end.getTime()) {
      return { start, end };
    }

    // We've crossed past now — pick the closer side
    if (start.getTime() > now.getTime()) {
      if (!prev) return { start, end };
      const distPrev = now.getTime() - prev.end.getTime();
      const distNext = start.getTime() - now.getTime();
      return distPrev <= distNext ? prev : { start, end };
    }

    prev = { start, end };

    switch (recurrence) {
      case 'daily':
        current.setDate(current.getDate() + 1);
        break;
      case 'weekly':
        current.setDate(current.getDate() + 7);
        break;
      case 'biweekly':
        current.setDate(current.getDate() + 14);
        break;
      case 'monthly':
        current.setMonth(current.getMonth() + 1);
        break;
      default:
        return { start: new Date(originalStart), end: new Date(originalEnd) };
    }
  }

  return prev ?? { start: new Date(originalStart), end: new Date(originalEnd) };
}

/**
 * Count how many occurrences of a meeting have already ended (end ≤ now).
 * For non-recurring meetings: 1 if it ended, 0 otherwise.
 * For recurring meetings: walks the recurrence pattern and counts ended
 * occurrences. Capped at 1000 iterations to bound a runaway case.
 */
export function countPastOccurrences(
  originalStart: Date,
  originalEnd: Date,
  recurrence: string | null,
  now: Date,
): number {
  if (!recurrence) {
    return originalEnd.getTime() <= now.getTime() ? 1 : 0;
  }

  const duration = originalEnd.getTime() - originalStart.getTime();
  const current = new Date(originalStart);
  let count = 0;

  for (let i = 0; i < 1000; i++) {
    const endOfThisOne = current.getTime() + duration;
    if (endOfThisOne > now.getTime()) break;
    count++;

    switch (recurrence) {
      case 'daily':
        current.setDate(current.getDate() + 1);
        break;
      case 'weekly':
        current.setDate(current.getDate() + 7);
        break;
      case 'biweekly':
        current.setDate(current.getDate() + 14);
        break;
      case 'monthly':
        current.setMonth(current.getMonth() + 1);
        break;
      default:
        return count;
    }
  }

  return count;
}

/**
 * Compute the punctuality of a join against the correct occurrence start.
 * Returns null if the user did not join.
 */
export function computePunctuality(
  meeting: { startTime: Date; recurrence: string | null },
  joinedAt: Date | null,
): {
  diffMinutes: number; // negative = early, positive = late
  isOnTime: boolean;
  label: string; // "on time" / "5 min late" / "3 min early"
} | null {
  if (!joinedAt) return null;

  const occurrenceStart = computeOccurrenceStart(
    new Date(meeting.startTime),
    meeting.recurrence,
    new Date(joinedAt),
  );
  const diffMinutes = Math.round(
    (new Date(joinedAt).getTime() - occurrenceStart.getTime()) / 60_000,
  );

  // On time = joined within ON_TIME_THRESHOLD_MINUTES after the start.
  // Joining early is also fine (still considered on time).
  const isOnTime = diffMinutes <= ON_TIME_THRESHOLD_MINUTES;

  const label =
    diffMinutes < -1
      ? `${Math.abs(diffMinutes)} min early`
      : isOnTime
      ? 'on time'
      : `${diffMinutes} min late`;

  return { diffMinutes, isOnTime, label };
}
