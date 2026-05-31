/**
 * Adapted from pi-cursor-sdk (MIT). See ATTRIBUTION.md.
 */
import type { ManifestCursorContext } from '../cursor-message-converter';
import { computeManifestContextFingerprint } from '../cursor-message-converter';

export const MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP = 20;

export type CursorSessionSendMode = 'bootstrap' | 'incremental';

export type CursorSessionSendReason =
  | 'initial'
  | 'context_divergence'
  | 'incremental_threshold'
  | 'incremental';

export interface SessionCursorAgentSendState {
  bootstrapped: boolean;
  contextFingerprint: string;
  incrementalSendCount: number;
}

export interface CursorSessionSendPlan {
  mode: CursorSessionSendMode;
  resetAgent: boolean;
  reason: CursorSessionSendReason;
}

export function shouldBootstrapCursorContext(
  sendState: SessionCursorAgentSendState,
  context: ManifestCursorContext,
): boolean {
  if (!sendState.bootstrapped) return true;
  if (!sendState.contextFingerprint) return true;
  return sendState.contextFingerprint !== computeManifestContextFingerprint(context);
}

export function planCursorSessionSend(
  sendState: SessionCursorAgentSendState,
  context: ManifestCursorContext,
): CursorSessionSendPlan {
  if (!sendState.bootstrapped) {
    return { mode: 'bootstrap', resetAgent: false, reason: 'initial' };
  }
  if (sendState.incrementalSendCount >= MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP) {
    return { mode: 'bootstrap', resetAgent: true, reason: 'incremental_threshold' };
  }
  if (shouldBootstrapCursorContext(sendState, context)) {
    return { mode: 'bootstrap', resetAgent: true, reason: 'context_divergence' };
  }
  return { mode: 'incremental', resetAgent: false, reason: 'incremental' };
}
