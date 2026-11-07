import { describe, expect, it } from 'vitest';
import { FatalRuleError } from '../src/rules';
import { isExpectedError } from '../src/sentry';

describe('isExpectedError', () => {
  it('drops normal outcomes', () => {
    expect(isExpectedError(new Error('SEB_NEEDS_REAUTH: refresh token expired'))).toBe(true);
    expect(isExpectedError(new Error('SEB_BAD_STATE: invalid or expired state'))).toBe(true);
    expect(isExpectedError(new FatalRuleError('create rule: HTTP 422'))).toBe(true);
  });

  it('keeps failures', () => {
    expect(isExpectedError(new Error('boom'))).toBe(false);
    expect(isExpectedError(new Error('SEB_TOKEN_ENDPOINT: HTTP 500'))).toBe(false);
    expect(isExpectedError(new Error('SEB_BREAKER: open'))).toBe(false);
  });
});
