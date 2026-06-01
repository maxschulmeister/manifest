/**
 * Adapted from pi-cursor-sdk (MIT). See ATTRIBUTION.md.
 *
 * OpenAI transcript helpers for Cursor live-run resume policy.
 * Live-run coordination lives in `manifest-cursor-live-run.ts`.
 */
import type { OpenAIMessage } from '../../routing/proxy/proxy-types';

/**
 * True when the transcript ends with tool result(s) followed by a new user turn
 * (OpenAI `tool` + `user` roles). Resume is skipped so the agent starts a fresh turn.
 */
export function hasTrailingUserMessagesAfterToolResults(messages: OpenAIMessage[]): boolean {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return false;
  for (let i = lastUserIndex - 1; i >= 0; i -= 1) {
    const role = messages[i]?.role;
    if (role === 'tool') return true;
    if (role === 'user') return false;
  }
  return false;
}
