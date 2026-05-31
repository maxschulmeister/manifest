/**
 * Manifest Cursor live-run coordinator for manifest__ tool bridge resume.
 * Adapted from pi-cursor-sdk cursor-live-run-coordinator.ts (MIT). See ATTRIBUTION.md.
 */
import type { SDKAgent } from '@cursor/sdk';
import type { OpenAIMessage } from '../../routing/proxy/proxy-types';
import type {
  ManifestBridgeToolRequest,
  ManifestToolBridgeRun,
} from './manifest-tool-bridge-types';

export class ManifestCursorLiveRunAbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'ManifestCursorLiveRunAbortError';
  }
}

export type ManifestLiveQueuedEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'bridge-tool'; request: ManifestBridgeToolRequest };

export interface ManifestCursorLiveSdkRun {
  cancel(): Promise<void>;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<{ status: string; result?: string }>;
}

export interface ManifestCursorLiveRun {
  id: string;
  scopeKey: string;
  agent: SDKAgent;
  bridgeRun?: ManifestToolBridgeRun;
  sdkRun?: ManifestCursorLiveSdkRun;
  pendingEvents: ManifestLiveQueuedEvent[];
  textDeltas: string[];
  done: boolean;
  cancelled: boolean;
  disposed: boolean;
  errorMessage?: string;
  consumedToolResultIds: Set<string>;
}

interface ProgressWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface PrivateState {
  waiters: Set<ProgressWaiter>;
}

const pendingRunsByScope = new Map<string, ManifestCursorLiveRun>();
const privateStates = new WeakMap<ManifestCursorLiveRun, PrivateState>();

function getPrivateState(run: ManifestCursorLiveRun): PrivateState {
  let state = privateStates.get(run);
  if (!state) {
    state = { waiters: new Set() };
    privateStates.set(run, state);
  }
  return state;
}

function notifyProgress(run: ManifestCursorLiveRun): void {
  const state = getPrivateState(run);
  const waiters = [...state.waiters];
  state.waiters.clear();
  for (const waiter of waiters) {
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve();
  }
}

export function startManifestCursorLiveRun(params: {
  id: string;
  scopeKey: string;
  agent: SDKAgent;
  bridgeRun?: ManifestToolBridgeRun;
}): ManifestCursorLiveRun {
  const existing = pendingRunsByScope.get(params.scopeKey);
  if (existing && !existing.disposed) {
    existing.disposed = true;
    pendingRunsByScope.delete(params.scopeKey);
  }

  const run: ManifestCursorLiveRun = {
    id: params.id,
    scopeKey: params.scopeKey,
    agent: params.agent,
    bridgeRun: params.bridgeRun,
    pendingEvents: [],
    textDeltas: [],
    done: false,
    cancelled: false,
    disposed: false,
    consumedToolResultIds: new Set(),
  };
  pendingRunsByScope.set(params.scopeKey, run);
  return run;
}

export function attachManifestCursorLiveSdkRun(
  run: ManifestCursorLiveRun,
  sdkRun: ManifestCursorLiveSdkRun,
): void {
  run.sdkRun = sdkRun;
}

export function queueManifestLiveEvent(
  run: ManifestCursorLiveRun,
  event: ManifestLiveQueuedEvent,
): void {
  if (run.disposed) return;
  run.pendingEvents.push(event);
  notifyProgress(run);
}

export function markManifestLiveRunFinished(run: ManifestCursorLiveRun): void {
  if (run.disposed) return;
  run.done = true;
  notifyProgress(run);
}

export function markManifestLiveRunCancelled(run: ManifestCursorLiveRun, message?: string): void {
  if (run.disposed) return;
  run.cancelled = true;
  run.errorMessage = message;
  run.done = true;
  notifyProgress(run);
}

export function markManifestLiveRunError(run: ManifestCursorLiveRun, errorMessage: string): void {
  if (run.disposed) return;
  run.errorMessage = errorMessage;
  run.done = true;
  notifyProgress(run);
}

export function peekManifestLiveEvent(
  run: ManifestCursorLiveRun,
): ManifestLiveQueuedEvent | undefined {
  return run.pendingEvents[0];
}

export function shiftManifestLiveEvent(
  run: ManifestCursorLiveRun,
): ManifestLiveQueuedEvent | undefined {
  return run.pendingEvents.shift();
}

export function collectManifestBridgeToolBatch(
  run: ManifestCursorLiveRun,
): ManifestBridgeToolRequest[] {
  const requests: ManifestBridgeToolRequest[] = [];
  const remaining: ManifestLiveQueuedEvent[] = [];
  for (const event of run.pendingEvents) {
    if (event.type === 'bridge-tool') {
      requests.push(event.request);
    } else {
      remaining.push(event);
    }
  }
  run.pendingEvents = remaining;
  return requests;
}

export function isManifestLiveRunReady(run: ManifestCursorLiveRun): boolean {
  return (
    run.disposed || run.pendingEvents.length > 0 || run.done || run.cancelled || !!run.errorMessage
  );
}

export const MANIFEST_BRIDGE_COLLECT_POLL_MS = 50;

export async function waitForBridgeToolOrLiveRunDone(
  run: ManifestCursorLiveRun,
  signal?: AbortSignal,
): Promise<void> {
  while (true) {
    if (signal?.aborted) throw new ManifestCursorLiveRunAbortError();
    if (run.pendingEvents.some((event) => event.type === 'bridge-tool')) return;
    if (run.done || run.cancelled || run.errorMessage) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, MANIFEST_BRIDGE_COLLECT_POLL_MS);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ManifestCursorLiveRunAbortError());
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export async function waitForManifestLiveRunProgress(
  run: ManifestCursorLiveRun,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new ManifestCursorLiveRunAbortError();
  if (isManifestLiveRunReady(run)) return;
  await new Promise<void>((resolve, reject) => {
    const state = getPrivateState(run);
    const waiter: ProgressWaiter = { resolve, reject, signal };
    const cleanup = (): void => {
      state.waiters.delete(waiter);
      if (waiter.onAbort) signal?.removeEventListener('abort', waiter.onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new ManifestCursorLiveRunAbortError());
    };
    waiter.onAbort = onAbort;
    waiter.resolve = () => {
      cleanup();
      resolve();
    };
    state.waiters.add(waiter);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (isManifestLiveRunReady(run)) waiter.resolve();
  });
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'text'
    ) {
      const text = (block as { text?: string }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

export function consumeOpenAiToolResultsForLiveRun(
  run: ManifestCursorLiveRun,
  messages: OpenAIMessage[],
): Array<{ toolCallId: string; content: string }> {
  const results: Array<{ toolCallId: string; content: string }> = [];
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
    if (!toolCallId || run.consumedToolResultIds.has(toolCallId)) continue;
    if (!run.bridgeRun?.hasPendingManifestToolCallId(toolCallId)) continue;
    run.consumedToolResultIds.add(toolCallId);
    results.push({ toolCallId, content: messageText(message.content) });
  }
  return results;
}

export function getManifestCursorLiveRunForScope(
  scopeKey: string,
): ManifestCursorLiveRun | undefined {
  const run = pendingRunsByScope.get(scopeKey);
  if (!run || run.disposed) return undefined;
  return run;
}

export async function releaseManifestCursorLiveRun(run: ManifestCursorLiveRun): Promise<void> {
  if (run.disposed) return;
  run.disposed = true;
  run.bridgeRun?.cancel('Manifest live run released');
  await run.bridgeRun?.dispose();
  if (run.sdkRun) await run.sdkRun.cancel().catch(() => undefined);
  pendingRunsByScope.delete(run.scopeKey);
}

export async function releaseAllManifestCursorLiveRunsForTests(): Promise<void> {
  const runs = [...pendingRunsByScope.values()];
  pendingRunsByScope.clear();
  await Promise.all(runs.map((run) => releaseManifestCursorLiveRun(run)));
}

export const manifestCursorLiveRuns = {
  count: (): number => pendingRunsByScope.size,
  getForScope: (scopeKey: string): ManifestCursorLiveRun | undefined =>
    pendingRunsByScope.get(scopeKey),
};
