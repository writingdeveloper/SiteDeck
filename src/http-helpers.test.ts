import { describe, it, expect } from 'vitest';
import { parsePeriod, isReauthError, isValidPropertyId } from './http-helpers';

describe('parsePeriod', () => {
  it('passes through the supported periods', () => {
    expect(parsePeriod('7')).toBe(7);
    expect(parsePeriod('28')).toBe(28);
    expect(parsePeriod('90')).toBe(90);
  });

  it('coerces null / empty / junk / unsupported values to 28', () => {
    expect(parsePeriod(null)).toBe(28);
    expect(parsePeriod('')).toBe(28);
    expect(parsePeriod('abc')).toBe(28);
    expect(parsePeriod('5')).toBe(28);
    expect(parsePeriod('900')).toBe(28);
  });
});

describe('isReauthError', () => {
  it('is true for the Google grant revocation/expiry signals', () => {
    expect(isReauthError(new Error('invalid_grant'))).toBe(true);
    expect(isReauthError(new Error('Token has been expired or revoked.'))).toBe(true);
    expect(isReauthError(new Error('invalid_token'))).toBe(true);
    expect(isReauthError('unauthorized_client')).toBe(true);
  });

  it('is false for ordinary/transient errors (so they stay a real 500, not a fake reconnect)', () => {
    expect(isReauthError(new Error('ECONNRESET'))).toBe(false);
    expect(isReauthError(new Error('RESOURCE_EXHAUSTED'))).toBe(false);
    expect(isReauthError(null)).toBe(false);
  });
});

describe('isValidPropertyId', () => {
  it('숫자 id를 허용', () => {
    expect(isValidPropertyId('123456789')).toBe(true);
  });
  it('null/빈값/비숫자/초과길이를 거부', () => {
    expect(isValidPropertyId(null)).toBe(false);
    expect(isValidPropertyId('')).toBe(false);
    expect(isValidPropertyId('12a')).toBe(false);
    expect(isValidPropertyId('../etc')).toBe(false);
    expect(isValidPropertyId('1'.repeat(21))).toBe(false);
  });
});
