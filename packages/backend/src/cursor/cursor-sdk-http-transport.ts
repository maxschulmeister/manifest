export const CURSOR_USE_HTTP1_ENV = 'CURSOR_USE_HTTP1';

/**
 * Cursor SDK defaults to HTTP/2 for api2.cursor.sh. In long-running backend
 * processes, the SDK's ConnectRPC HTTP/2 stream can reject in a background
 * promise with NGHTTP2_REFUSED_STREAM and crash Node. Prefer HTTP/1 unless an
 * operator explicitly opts into another SDK transport.
 */
export function ensureCursorSdkHttpTransport(): void {
  if (process.env[CURSOR_USE_HTTP1_ENV] === undefined) {
    process.env[CURSOR_USE_HTTP1_ENV] = 'true';
  }
}

export function loadCursorSdk(): typeof import('@cursor/sdk') {
  ensureCursorSdkHttpTransport();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@cursor/sdk') as typeof import('@cursor/sdk');
}
