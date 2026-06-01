import { CURSOR_USE_HTTP1_ENV, ensureCursorSdkHttpTransport } from './cursor-sdk-http-transport';

describe('cursor-sdk-http-transport', () => {
  const originalValue = process.env[CURSOR_USE_HTTP1_ENV];

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[CURSOR_USE_HTTP1_ENV];
    } else {
      process.env[CURSOR_USE_HTTP1_ENV] = originalValue;
    }
  });

  it('defaults Cursor SDK traffic to HTTP/1 without requiring user env configuration', () => {
    delete process.env[CURSOR_USE_HTTP1_ENV];

    ensureCursorSdkHttpTransport();

    expect(process.env[CURSOR_USE_HTTP1_ENV]).toBe('true');
  });

  it('preserves an explicit Cursor SDK transport override', () => {
    process.env[CURSOR_USE_HTTP1_ENV] = 'false';

    ensureCursorSdkHttpTransport();

    expect(process.env[CURSOR_USE_HTTP1_ENV]).toBe('false');
  });
});
