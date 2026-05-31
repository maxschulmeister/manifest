/**
 * Adapted from pi-cursor-sdk (MIT). See ATTRIBUTION.md.
 *
 * Shared helpers for OpenAI transcript shape and a lightweight run registry.
 * Live-run drain, bridge batching, and resume live in `manifest-cursor-live-run.ts`.
 */
import type { OpenAIMessage } from '../../routing/proxy/proxy-types';

export const DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS = 5 * 60 * 1000;

export interface ManifestCursorLiveRun {
  id: string;
  scopeKey: string;
  disposed: boolean;
}

const runsByScope = new Map<string, ManifestCursorLiveRun>();

let idleDisposeMs = DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;

/**
 * True when the transcript ends with tool result(s) followed by a new user turn
 * (OpenAI `tool` + `user` roles). Used by Phase 3 resume planning.
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

export function registerManifestCursorLiveRun(scopeKey: string, id: string): ManifestCursorLiveRun {
  const run: ManifestCursorLiveRun = { id, scopeKey, disposed: false };
  runsByScope.set(scopeKey, run);
  return run;
}

export function getManifestCursorLiveRun(scopeKey: string): ManifestCursorLiveRun | undefined {
  return runsByScope.get(scopeKey);
}

export function disposeManifestCursorLiveRun(scopeKey: string): void {
  const run = runsByScope.get(scopeKey);
  if (!run) return;
  run.disposed = true;
  runsByScope.delete(scopeKey);
}

export function setCursorNativeReplayIdleDisposeMs(value: number): void {
  idleDisposeMs = value;
}

export function resetCursorNativeReplayIdleDisposeMs(): void {
  idleDisposeMs = DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS;
}

export function getCursorNativeReplayIdleDisposeMs(): number {
  return idleDisposeMs;
}

export const cursorLiveRuns = {
  count: (): number => runsByScope.size,
  getForScope: (scopeKey: string): ManifestCursorLiveRun | undefined => runsByScope.get(scopeKey),
};

export async function releaseAllPendingCursorLiveRunsForTests(): Promise<void> {
  runsByScope.clear();
}
