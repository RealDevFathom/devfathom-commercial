import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => {
  const client = {
    generateAuthUrl: vi.fn(),
    getToken: vi.fn(),
    setCredentials: vi.fn(),
  };
  const messages = { list: vi.fn(), get: vi.fn(), send: vi.fn() };
  const getProfile = vi.fn();
  return {
    client,
    messages,
    getProfile,
    OAuth2: vi.fn(function () {
      return client;
    }),
    gmail: vi.fn(() => ({ users: { messages, getProfile } })),
  };
});

// Keep this mock at the narrow entry point: importing the umbrella SDK again
// must not silently pass these adapter/consent regressions.
vi.mock('googleapis/build/src/apis/gmail', () => ({
  auth: { OAuth2: sdk.OAuth2 },
  gmail: sdk.gmail,
}));

import { buildConsentUrl, exchangeCode, googleOAuthClient } from './oauth';
import { GmailAdapter } from './providers/gmail';

const adapter = () =>
  new GmailAdapter({ emailAddress: 'sender@example.invalid', refreshToken: 'synthetic-refresh' });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'synthetic-not-a-credential');
  vi.stubEnv('GOOGLE_OAUTH_REDIRECT_URI', 'https://example.invalid/oauth/callback');
  sdk.OAuth2.mockImplementation(function () {
    return sdk.client;
  });
  sdk.gmail.mockImplementation(() => ({
    users: { messages: sdk.messages, getProfile: sdk.getProfile },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Gmail-only SDK entry point', () => {
  it('constructs OAuth with the configured client and redirect', () => {
    expect(googleOAuthClient()).toBe(sdk.client);
    expect(sdk.OAuth2).toHaveBeenCalledWith(
      'synthetic-client',
      'synthetic-not-a-credential',
      'https://example.invalid/oauth/callback'
    );
  });

  it('preserves consent scopes, offline refresh and caller state', () => {
    sdk.client.generateAuthUrl.mockReturnValue('https://example.invalid/consent');
    expect(buildConsentUrl('GMAIL', 'caller-state')).toBe('https://example.invalid/consent');
    expect(sdk.client.generateAuthUrl).toHaveBeenCalledWith({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ],
      state: 'caller-state',
      include_granted_scopes: true,
    });
  });

  it('exchanges a code and looks up the account with explicit authentication', async () => {
    const tokens = { refresh_token: 'synthetic-refresh', access_token: 'synthetic-access' };
    sdk.client.getToken.mockResolvedValue({ tokens });
    sdk.getProfile.mockResolvedValue({ data: { emailAddress: 'sender@example.invalid' } });
    await expect(exchangeCode('GMAIL', 'synthetic-code')).resolves.toEqual({
      refreshToken: 'synthetic-refresh',
      emailAddress: 'sender@example.invalid',
    });
    expect(sdk.client.getToken).toHaveBeenCalledWith('synthetic-code');
    expect(sdk.client.setCredentials).toHaveBeenCalledWith(tokens);
    expect(sdk.gmail).toHaveBeenCalledWith({ version: 'v1', auth: sdk.client });
    expect(sdk.getProfile).toHaveBeenCalledWith({ userId: 'me' });
  });

  it('rejects a missing refresh token before calling Gmail', async () => {
    sdk.client.getToken.mockResolvedValue({ tokens: {} });
    await expect(exchangeCode('GMAIL', 'synthetic-code')).rejects.toThrow(/refresh token/i);
    expect(sdk.gmail).not.toHaveBeenCalled();
  });

  it('rejects a missing Gmail account address', async () => {
    sdk.client.getToken.mockResolvedValue({ tokens: { refresh_token: 'synthetic-refresh' } });
    sdk.getProfile.mockResolvedValue({ data: {} });
    await expect(exchangeCode('GMAIL', 'synthetic-code')).rejects.toThrow(/account address/i);
  });

  it('fails closed when Gmail is not configured', () => {
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', '');
    expect(() => googleOAuthClient()).toThrow(/not configured/i);
    expect(sdk.OAuth2).not.toHaveBeenCalled();
  });

  it('preserves list pagination, metadata headers and explicit refresh authentication', async () => {
    sdk.messages.list.mockResolvedValue({
      data: { messages: [{ id: 'message-1' }, {}], nextPageToken: 'next-page' },
    });
    sdk.messages.get.mockResolvedValue({ data: { id: 'message-1', payload: { headers: [] } } });
    const result = await adapter().listMessages({ limit: 7, pageToken: 'current-page' });
    expect(sdk.client.setCredentials).toHaveBeenCalledWith({ refresh_token: 'synthetic-refresh' });
    expect(sdk.gmail).toHaveBeenCalledWith({ version: 'v1', auth: sdk.client });
    expect(sdk.messages.list).toHaveBeenCalledWith({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: 7,
      pageToken: 'current-page',
    });
    expect(sdk.messages.get).toHaveBeenCalledExactlyOnceWith({
      userId: 'me',
      id: 'message-1',
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.nextPageToken).toBe('next-page');
  });

  it('preserves default inbox size and empty results', async () => {
    sdk.messages.list.mockResolvedValue({ data: {} });
    await expect(adapter().listMessages()).resolves.toEqual({ messages: [], nextPageToken: null });
    expect(sdk.messages.list).toHaveBeenCalledWith({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: 30,
      pageToken: undefined,
    });
    expect(sdk.messages.get).not.toHaveBeenCalled();
  });

  it('continues delegating sync to the list operation', async () => {
    const instance = adapter();
    const result = { messages: [], nextPageToken: null };
    const list = vi.spyOn(instance, 'listMessages').mockResolvedValue(result);
    await expect(instance.sync({ limit: 5 })).resolves.toBe(result);
    expect(list).toHaveBeenCalledWith({ limit: 5 });
  });

  it('fetches full messages using the requested provider id', async () => {
    sdk.messages.get.mockResolvedValue({ data: { id: 'message-2', payload: { headers: [] } } });
    expect(await adapter().getMessage('message-2')).toMatchObject({
      providerMessageId: 'message-2',
    });
    expect(sdk.messages.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'message-2',
      format: 'full',
    });
  });

  it('preserves missing-message handling', async () => {
    sdk.messages.get.mockResolvedValue({ data: null });
    await expect(adapter().getMessage('missing')).resolves.toBeNull();
  });

  it('preserves outbound MIME encoding and provider message identity', async () => {
    sdk.messages.send.mockResolvedValue({ data: { id: 'sent-1' } });
    await expect(
      adapter().sendMessage({
        to: ['recipient@example.invalid'],
        cc: ['copy@example.invalid'],
        subject: 'Gmail adapter regression',
        html: '<p>Unchanged body</p>',
      })
    ).resolves.toEqual({ providerMessageId: 'sent-1' });
    expect(sdk.messages.send).toHaveBeenCalledOnce();
    const request = sdk.messages.send.mock.calls[0]![0];
    expect(request.userId).toBe('me');
    expect(request.requestBody.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(request.requestBody.raw, 'base64url').toString('utf8')).toBe(
      'From: sender@example.invalid\r\nTo: recipient@example.invalid\r\n' +
        'Cc: copy@example.invalid\r\nSubject: Gmail adapter regression\r\n' +
        'MIME-Version: 1.0\r\nContent-Type: text/html; charset="UTF-8"\r\n\r\n<p>Unchanged body</p>'
    );
  });

  it('preserves a null provider id when Gmail omits it', async () => {
    sdk.messages.send.mockResolvedValue({ data: {} });
    await expect(
      adapter().sendMessage({
        to: ['recipient@example.invalid'],
        subject: 'No id',
        html: '',
      })
    ).resolves.toEqual({ providerMessageId: null });
  });
});
