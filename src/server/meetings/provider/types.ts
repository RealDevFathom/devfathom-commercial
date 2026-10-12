import 'server-only';

export type MeetingProviderKind = 'livekit';

export type MeetingProviderCapabilities = {
  tokenRevocation: 'none';
  egress: false;
  roomDistribution: false;
  selectiveSubscription: true;
  webhooks: 'signed-at-least-once';
};

export const meetingProviderCapabilities: MeetingProviderCapabilities = {
  tokenRevocation: 'none',
  egress: false,
  roomDistribution: false,
  selectiveSubscription: true,
  webhooks: 'signed-at-least-once',
};

export type NormalizedMeetingEventType =
  'room.started' | 'room.finished' | 'participant.joined' | 'participant.left' | 'unmapped';

export type NormalizedMeetingEvent = {
  id: string;
  type: NormalizedMeetingEventType;
  providerType: string;
  roomName: string;
  participantId?: string;
  participantIdentity?: string;
  occurredAt: Date;
  payload: unknown;
};

export type ProviderParticipantState = {
  id: string;
  identity: string;
  joinedAt: Date;
};

export type ProviderRoomState = {
  exists: boolean;
  active: boolean;
  startedAt?: Date;
  endedAt?: Date;
  participants: ProviderParticipantState[];
};

export interface MeetingProviderAdapter {
  readonly kind: MeetingProviderKind;
  readonly capabilities: MeetingProviderCapabilities;
  verifyAndNormalizeWebhook(rawBody: Uint8Array, headers: Headers): Promise<NormalizedMeetingEvent>;
  getRoomState(roomName: string): Promise<ProviderRoomState>;
}

export class MeetingProviderError extends Error {
  constructor(readonly code: 'unavailable' | 'not-found' | 'refused' | 'invalid') {
    super(`Meeting provider ${code}`);
    this.name = 'MeetingProviderError';
  }
}
