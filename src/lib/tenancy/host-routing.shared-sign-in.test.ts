import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyHost, sharedSignInUrl } from './host-routing';

const ORIGINAL_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN;
const ORIGINAL_SHARED_HOSTS = process.env.SHARED_APP_HOSTS;

beforeEach(() => {
  delete process.env.PLATFORM_BASE_DOMAIN;
  delete process.env.SHARED_APP_HOSTS;
});

afterEach(() => {
  if (ORIGINAL_BASE_DOMAIN === undefined) delete process.env.PLATFORM_BASE_DOMAIN;
  else process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
  if (ORIGINAL_SHARED_HOSTS === undefined) delete process.env.SHARED_APP_HOSTS;
  else process.env.SHARED_APP_HOSTS = ORIGINAL_SHARED_HOSTS;
});

describe('sharedSignInUrl', () => {
  it('points at the shared sign-in on the base domain apex', () => {
    process.env.PLATFORM_BASE_DOMAIN = 'pharmacy.example.com';
    const url = sharedSignInUrl('pharmacy');
    expect(url).toBe('https://pharmacy.example.com/login?vertical=pharmacy');
    expect(classifyHost(new URL(url!).host).kind).toBe('shared');
  });

  it('adds no vertical for the default workspace', () => {
    process.env.PLATFORM_BASE_DOMAIN = 'example.com';
    expect(sharedSignInUrl('default')).toBe('https://example.com/login');
    expect(sharedSignInUrl()).toBe('https://example.com/login');
  });

  it('uses http for a localhost base domain', () => {
    process.env.PLATFORM_BASE_DOMAIN = 'localhost';
    expect(sharedSignInUrl('hotel')).toBe('http://localhost/login?vertical=hotel');
  });

  it('returns null when no base domain is configured', () => {
    expect(sharedSignInUrl('pharmacy')).toBeNull();
  });
});
