import { describe, it, expect } from 'vitest';
import { parsePeriod, isReauthError, isValidPropertyId, isSameOriginRequest } from './http-helpers';

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

describe('isSameOriginRequest', () => {
  const allowed = ['http://localhost:4317', 'http://127.0.0.1:4317'];

  it('동일 출처 origin은 허용', () => {
    expect(isSameOriginRequest({ origin: 'http://127.0.0.1:4317' }, allowed)).toBe(true);
    expect(isSameOriginRequest({ origin: 'http://localhost:4317' }, allowed)).toBe(true);
  });

  it('origin이 없으면 허용 — 브라우저는 크로스오리진 POST에 항상 Origin을 붙이므로, 없다는 건 브라우저 크로스사이트가 아니라는 뜻(curl/스크립트)', () => {
    expect(isSameOriginRequest({}, allowed)).toBe(true);
  });

  it('크로스사이트 origin은 거부 — 사용자가 방문한 악성 사이트의 POST', () => {
    expect(isSameOriginRequest({ origin: 'https://evil.example' }, allowed)).toBe(false);
  });

  it('다른 로컬 포트의 origin도 거부 — 다른 로컬 앱이 우리 설정을 만질 수 없다', () => {
    expect(isSameOriginRequest({ origin: 'http://127.0.0.1:4318' }, allowed)).toBe(false);
  });

  it('sec-fetch-site: cross-site / same-site 는 거부', () => {
    expect(isSameOriginRequest({ 'sec-fetch-site': 'cross-site' }, allowed)).toBe(false);
    expect(isSameOriginRequest({ 'sec-fetch-site': 'same-site' }, allowed)).toBe(false);
  });

  it('sec-fetch-site: same-origin / none 은 허용', () => {
    expect(isSameOriginRequest({ 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4317' }, allowed)).toBe(true);
    expect(isSameOriginRequest({ 'sec-fetch-site': 'none' }, allowed)).toBe(true);
  });

  it('중복된 헤더(배열)는 거부', () => {
    expect(isSameOriginRequest({ 'sec-fetch-site': ['same-origin', 'cross-site'] }, allowed)).toBe(false);
  });
});
