import { describe, expect, it } from 'vitest';
import { hashUazapiToken } from './uazapi-webhook-auth';

describe('hashUazapiToken', () => {
  it('is deterministic', () => {
    const a = hashUazapiToken('8cdf0d62-925b-4878-b1e1-70dde3b6590b');
    const b = hashUazapiToken('8cdf0d62-925b-4878-b1e1-70dde3b6590b');
    expect(a).toBe(b);
  });

  it('produces a 64-char hex sha256 digest', () => {
    const hash = hashUazapiToken('tok-123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different tokens hash differently', () => {
    expect(hashUazapiToken('tok-a')).not.toBe(hashUazapiToken('tok-b'));
  });
});
