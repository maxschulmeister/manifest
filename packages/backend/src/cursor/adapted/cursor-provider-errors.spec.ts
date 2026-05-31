import {
  MISSING_CURSOR_API_KEY_MESSAGE,
  cursorProviderErrorResponse,
  sanitizeCursorProviderError,
} from './cursor-provider-errors';

describe('cursor-provider-errors', () => {
  it('scrubs api key from error messages', () => {
    expect(
      sanitizeCursorProviderError(new Error('bad key sk-cursor-secret'), 'sk-cursor-secret'),
    ).not.toContain('sk-cursor-secret');
  });

  it('maps auth-like errors to auth message', () => {
    expect(sanitizeCursorProviderError(new Error('401 Unauthorized'))).toMatch(
      /invalid or unauthorized/i,
    );
  });

  it('maps network timeouts', () => {
    expect(sanitizeCursorProviderError(new Error('read ETIMEDOUT'))).toMatch(/timed out/i);
  });

  it('returns missing key message unchanged', () => {
    expect(sanitizeCursorProviderError(new Error(MISSING_CURSOR_API_KEY_MESSAGE))).toBe(
      MISSING_CURSOR_API_KEY_MESSAGE,
    );
  });

  it('maps non-error unknown values to generic message', () => {
    expect(sanitizeCursorProviderError({ code: 1 })).toMatch(/request failed/i);
  });

  it('maps generic empty errors', () => {
    expect(sanitizeCursorProviderError(new Error(''))).toMatch(/request failed/i);
    expect(sanitizeCursorProviderError('')).toMatch(/request failed/i);
  });

  it('builds JSON error responses', async () => {
    const res = cursorProviderErrorResponse('failed', 503);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('failed');
  });
});
