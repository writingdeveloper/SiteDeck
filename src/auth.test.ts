import { describe, it, expect } from 'vitest';
import { parseInstalledCredentials } from './auth';
import { AppError } from './errors';

describe('parseInstalledCredentials', () => {
  it('reads an installed (desktop) client', () => {
    const raw = JSON.stringify({ installed: { client_id: 'id', client_secret: 'sec' } });
    expect(parseInstalledCredentials(raw)).toEqual({ clientId: 'id', clientSecret: 'sec' });
  });

  it('accepts a top-level / web shape too', () => {
    expect(parseInstalledCredentials(JSON.stringify({ client_id: 'id', client_secret: 'sec' }))).toEqual({
      clientId: 'id',
      clientSecret: 'sec',
    });
  });

  it('throws credentials_invalid when client_id/secret are missing', () => {
    try {
      parseInstalledCredentials(JSON.stringify({ installed: { client_secret: 'sec' } }));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('credentials_invalid');
    }
  });

  it('throws credentials_invalid on malformed JSON', () => {
    try {
      parseInstalledCredentials('not json');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('credentials_invalid');
    }
  });
});
