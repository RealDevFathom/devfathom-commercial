import { TRPCError } from '@trpc/server';
import { PIN_CHANGE_REQUIRED } from './own-pin-policy';

export class ApprovalPinChangeRequired extends TRPCError {
  constructor() {
    super({ code: 'FORBIDDEN', message: PIN_CHANGE_REQUIRED });
  }
}
