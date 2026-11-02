/**
 * The one rule for a meeting's time range — DEV-249 / #451.
 *
 * A meeting must END STRICTLY AFTER it STARTS. Equal instants are rejected as
 * well as backwards ones: a zero-length meeting has no occurrence anyone can
 * join, and the materialiser turns it into a series of zero-length rooms.
 *
 * Every writer of `Meeting.startTime` / `Meeting.endTime` checks this module:
 * the tRPC `meetings.create` / `meetings.update` procedures, the REST
 * `POST /api/v1/meetings` route, the assistant's `createMeeting` /
 * `updateMeeting` tools, and the meeting forms in the UI. Moving one occurrence
 * (`meetings.rescheduleOccurrence`) applies the same rule. The
 * `meetings_time_order_check` CHECK constraint
 * (`prisma/migrations/20261102090200_meeting_time_order_check`) is the floor
 * under all of them; checking here first turns a database error into a message
 * a person can act on.
 *
 * No server-only imports: the forms run this in the browser.
 */

/** What every surface tells a person whose meeting ends at or before it starts. */
export const MEETING_TIME_ORDER_MESSAGE = 'End time must be after the start time.';

/**
 * True only when `end` is strictly after `start`. An invalid date is never in
 * order (`NaN > x` is false), so a value that failed to parse cannot pass.
 */
export function isMeetingTimeOrderValid(start: Date, end: Date): boolean {
  return end.getTime() > start.getTime();
}

/** The user-facing message when the range is out of order, otherwise null. */
export function meetingTimeOrderError(start: Date, end: Date): string | null {
  return isMeetingTimeOrderValid(start, end) ? null : MEETING_TIME_ORDER_MESSAGE;
}

/** A day the forms judge two times on before the person has picked a date. */
const REFERENCE_DAY = '2000-01-03';

/**
 * The range a same-day meeting form describes: one `YYYY-MM-DD` date and two
 * `HH:mm` wall-clock times in the browser's zone — exactly the instants the
 * forms submit. Null until both times are chosen, so an untouched form shows
 * no error. Before a date is chosen the times are judged on a reference day,
 * which lets the message appear as soon as the second time is picked.
 */
export function meetingFormTimeOrderError(
  date: string,
  startTime: string,
  endTime: string
): string | null {
  if (!startTime || !endTime) return null;
  const day = date || REFERENCE_DAY;
  return meetingTimeOrderError(new Date(`${day}T${startTime}`), new Date(`${day}T${endTime}`));
}

export type MeetingTimes = { startTime: Date; endTime: Date };

/**
 * Check the range a PARTIAL update would leave stored.
 *
 * A patch that supplies only one side is judged against the other side as it is
 * stored now — moving a 10:00–11:00 meeting's start to 11:30 must fail even
 * though the patch never mentions the end. `loadStored` runs only in that case,
 * so a patch that touches neither or both sides costs no read.
 *
 * Returns null when there is nothing to check, or when `loadStored` finds no
 * meeting: the caller's own not-found handling owns that answer.
 */
export async function meetingTimeOrderErrorForPatch(
  patch: { startTime?: Date | null; endTime?: Date | null },
  loadStored: () => Promise<MeetingTimes | null>
): Promise<string | null> {
  const { startTime, endTime } = patch;
  if (startTime == null && endTime == null) return null;
  if (startTime != null && endTime != null) return meetingTimeOrderError(startTime, endTime);

  const stored = await loadStored();
  if (!stored) return null;
  return meetingTimeOrderError(startTime ?? stored.startTime, endTime ?? stored.endTime);
}
