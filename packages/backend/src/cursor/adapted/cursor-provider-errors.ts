/**
 * Adapted from pi-cursor-sdk (MIT). See ../adapted/ATTRIBUTION.md.
 */

export const MISSING_CURSOR_API_KEY_MESSAGE =
  'Cursor SDK runs require a Cursor API key. Set CURSOR_API_KEY or connect Cursor as a subscription provider in Manifest.';

const GENERIC_CURSOR_SDK_ERROR_MESSAGE =
  'Cursor SDK request failed, but Cursor did not provide provider error details. ' +
  'Check Cursor status, credentials, and usage limits, then retry.';

const AUTH_CURSOR_SDK_ERROR_MESSAGE =
  'Cursor SDK request failed because the API key may be invalid or unauthorized. Verify the key and retry.';

const NETWORK_CURSOR_SDK_ERROR_MESSAGE =
  'Cursor SDK request timed out during network I/O. Check your connection and retry.';

function isGenericErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized === '' ||
    normalized === 'error' ||
    normalized === 'unknown error' ||
    normalized === 'failed' ||
    normalized === 'run failed' ||
    normalized === 'cursor sdk run failed' ||
    normalized === 'cursor sdk request failed'
  );
}

function isLikelyAuthError(message: string): boolean {
  return /\b(unauthenticated|unauthorized|unauthorised|forbidden|invalid api key|invalid key|authentication|auth|401|403)\b/i.test(
    message,
  );
}

function isLikelyNetworkTimeout(message: string): boolean {
  return (
    /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ERR_HTTP2_STREAM_ERROR)\b/i.test(
      message,
    ) ||
    /\b(NGHTTP2_REFUSED_STREAM|REFUSED_STREAM)\b/i.test(message) ||
    /\bConnectError\b.*\b(unavailable|deadline|timeout|timed out|refused stream)\b/i.test(
      message,
    ) ||
    /\bread ETIMEDOUT\b/i.test(message)
  );
}

function scrubApiKey(text: string, apiKey?: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

export function sanitizeCursorProviderError(error: unknown, apiKey?: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message === MISSING_CURSOR_API_KEY_MESSAGE) return MISSING_CURSOR_API_KEY_MESSAGE;
  const scrubbed = scrubApiKey(message, apiKey).trim();
  if (isLikelyAuthError(scrubbed)) return AUTH_CURSOR_SDK_ERROR_MESSAGE;
  if (isGenericErrorMessage(scrubbed)) return GENERIC_CURSOR_SDK_ERROR_MESSAGE;
  if (isLikelyNetworkTimeout(scrubbed)) return NETWORK_CURSOR_SDK_ERROR_MESSAGE;
  return scrubbed || GENERIC_CURSOR_SDK_ERROR_MESSAGE;
}

export function cursorProviderErrorResponse(message: string, status = 502): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: 'cursor_provider_error',
        code: 'cursor_provider_error',
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

export function cursorProviderErrorSsePayload(message: string): string {
  return `data: ${JSON.stringify({
    error: {
      message,
      type: 'cursor_provider_error',
      code: 'cursor_provider_error',
    },
  })}\n\ndata: [DONE]\n\n`;
}
