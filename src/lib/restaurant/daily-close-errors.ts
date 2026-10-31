export type DailyCloseErrorReason =
  | 'UNSETTLED_BILL'
  | 'OPEN_DRAWER'
  | 'FUTURE_BUSINESS_DATE'
  | 'CLOSE_EXISTS'
  | 'NOTHING_TO_CORRECT'
  | 'NOT_TIP'
  | 'CO_AUTH_REQUIRED'
  | 'REASON_REQUIRED'
  | 'CLOSE_NOT_FOUND'
  | 'INVALID';

export class DailyCloseError extends Error {
  constructor(
    message: string,
    readonly reason: DailyCloseErrorReason
  ) {
    super(message);
    this.name = 'DailyCloseError';
  }
}
