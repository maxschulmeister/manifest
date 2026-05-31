import type { ManifestToolBridgeRun } from './manifest-tool-bridge-types';
import {
  ManifestCursorLiveRunAbortError,
  attachManifestCursorLiveSdkRun,
  collectManifestBridgeToolBatch,
  consumeOpenAiToolResultsForLiveRun,
  getManifestCursorLiveRunForScope,
  isManifestLiveRunReady,
  manifestCursorLiveRuns,
  markManifestLiveRunCancelled,
  markManifestLiveRunError,
  markManifestLiveRunFinished,
  peekManifestLiveEvent,
  queueManifestLiveEvent,
  releaseAllManifestCursorLiveRunsForTests,
  releaseManifestCursorLiveRun,
  shiftManifestLiveEvent,
  startManifestCursorLiveRun,
  waitForBridgeToolOrLiveRunDone,
  waitForManifestLiveRunProgress,
} from './manifest-cursor-live-run';

describe('manifest-cursor-live-run', () => {
  afterEach(async () => {
    await releaseAllManifestCursorLiveRunsForTests();
  });

  it('queues and collects bridge tool batches', () => {
    const run = startManifestCursorLiveRun({
      id: 'live-1',
      scopeKey: 'scope-1',
      agent: { agentId: 'a' } as never,
    });
    queueManifestLiveEvent(run, {
      type: 'bridge-tool',
      request: {
        runId: 'live-1',
        bridgeCallId: 'b1',
        manifestToolCallId: 'call-1',
        agentToolName: 'bash',
        mcpToolName: 'manifest__bash',
        args: {},
      },
    });
    expect(collectManifestBridgeToolBatch(run)).toHaveLength(1);
    expect(manifestCursorLiveRuns.count()).toBe(1);
  });

  it('collects bridge tools even when text deltas are queued first', () => {
    const run = startManifestCursorLiveRun({
      id: 'live-mixed',
      scopeKey: 'scope-mixed',
      agent: { agentId: 'a' } as never,
    });
    queueManifestLiveEvent(run, { type: 'text-delta', text: 'hello' });
    queueManifestLiveEvent(run, {
      type: 'bridge-tool',
      request: {
        runId: 'live-mixed',
        bridgeCallId: 'b1',
        manifestToolCallId: 'call-1',
        agentToolName: 'bash',
        mcpToolName: 'manifest__bash',
        args: {},
      },
    });
    expect(collectManifestBridgeToolBatch(run)).toHaveLength(1);
    expect(run.pendingEvents).toEqual([{ type: 'text-delta', text: 'hello' }]);
  });

  it('consumes OpenAI tool results matching pending bridge calls', () => {
    const pendingIds = new Set(['call-1']);
    const bridgeRun = {
      hasPendingManifestToolCallId: (id: string) => pendingIds.has(id),
      hasPendingToolCalls: () => pendingIds.size > 0,
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as ManifestToolBridgeRun;

    const run = startManifestCursorLiveRun({
      id: 'live-2',
      scopeKey: 'scope-2',
      agent: { agentId: 'a' } as never,
      bridgeRun,
    });

    const consumed = consumeOpenAiToolResultsForLiveRun(run, [
      { role: 'tool', tool_call_id: 'call-1', content: 'done' },
      { role: 'tool', tool_call_id: 'other', content: 'skip' },
    ]);
    expect(consumed).toEqual([{ toolCallId: 'call-1', content: 'done' }]);
    expect(run.consumedToolResultIds.has('call-1')).toBe(true);
  });

  it('parses array tool result content blocks', () => {
    const bridgeRun = {
      hasPendingManifestToolCallId: () => true,
      hasPendingToolCalls: () => true,
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as ManifestToolBridgeRun;
    const run = startManifestCursorLiveRun({
      id: 'live-3',
      scopeKey: 'scope-3',
      agent: { agentId: 'a' } as never,
      bridgeRun,
    });
    const consumed = consumeOpenAiToolResultsForLiveRun(run, [
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: [{ type: 'text', text: 'block' }],
      },
    ]);
    expect(consumed[0]?.content).toBe('block');
  });

  it('replaces an existing undisposed run for the same scope', () => {
    const first = startManifestCursorLiveRun({
      id: 'old',
      scopeKey: 'scope-replace',
      agent: { agentId: 'a' } as never,
    });
    const second = startManifestCursorLiveRun({
      id: 'new',
      scopeKey: 'scope-replace',
      agent: { agentId: 'b' } as never,
    });
    expect(first.disposed).toBe(true);
    expect(getManifestCursorLiveRunForScope('scope-replace')?.id).toBe('new');
    expect(second.disposed).toBe(false);
  });

  it('marks finished, cancelled, and error states', async () => {
    const run = startManifestCursorLiveRun({
      id: 'live-4',
      scopeKey: 'scope-4',
      agent: { agentId: 'a' } as never,
    });
    markManifestLiveRunFinished(run);
    expect(isManifestLiveRunReady(run)).toBe(true);

    const run2 = startManifestCursorLiveRun({
      id: 'live-5',
      scopeKey: 'scope-5',
      agent: { agentId: 'a' } as never,
    });
    markManifestLiveRunCancelled(run2, 'aborted');
    expect(run2.cancelled).toBe(true);

    const run3 = startManifestCursorLiveRun({
      id: 'live-6',
      scopeKey: 'scope-6',
      agent: { agentId: 'a' } as never,
    });
    markManifestLiveRunError(run3, 'boom');
    expect(run3.errorMessage).toBe('boom');
  });

  it('aborts bridge poll wait when signal is already aborted during setup', async () => {
    let checkCount = 0;
    const signal = {
      get aborted() {
        checkCount += 1;
        return checkCount >= 2;
      },
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as AbortSignal;
    const run = startManifestCursorLiveRun({
      id: 'live-bridge-abort-setup',
      scopeKey: 'scope-bridge-abort-setup',
      agent: { agentId: 'a' } as never,
    });
    await expect(waitForBridgeToolOrLiveRunDone(run, signal)).rejects.toBeInstanceOf(
      ManifestCursorLiveRunAbortError,
    );
  });

  it('aborts when signal becomes aborted during wait setup', async () => {
    let checkCount = 0;
    const signal = {
      get aborted() {
        checkCount += 1;
        return checkCount >= 2;
      },
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as AbortSignal;
    const run = startManifestCursorLiveRun({
      id: 'live-abort-setup',
      scopeKey: 'scope-abort-setup',
      agent: { agentId: 'a' } as never,
    });
    await expect(waitForManifestLiveRunProgress(run, signal)).rejects.toBeInstanceOf(
      ManifestCursorLiveRunAbortError,
    );
  });

  it('waits for progress and aborts on signal', async () => {
    const run = startManifestCursorLiveRun({
      id: 'live-7',
      scopeKey: 'scope-7',
      agent: { agentId: 'a' } as never,
    });
    const controller = new AbortController();
    const waitPromise = waitForManifestLiveRunProgress(run, controller.signal);
    controller.abort();
    await expect(waitPromise).rejects.toBeInstanceOf(ManifestCursorLiveRunAbortError);
  });

  it('resolves wait when progress arrives', async () => {
    const run = startManifestCursorLiveRun({
      id: 'live-8',
      scopeKey: 'scope-8',
      agent: { agentId: 'a' } as never,
    });
    const waitPromise = waitForManifestLiveRunProgress(run);
    queueManifestLiveEvent(run, { type: 'text-delta', text: 'hi' });
    await waitPromise;
    expect(peekManifestLiveEvent(run)?.type).toBe('text-delta');
    expect(shiftManifestLiveEvent(run)?.type).toBe('text-delta');
  });

  it('releases sdk run and bridge on release', async () => {
    const bridgeRun = {
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as ManifestToolBridgeRun;
    const sdkRun = {
      cancel: jest.fn().mockResolvedValue(undefined),
      stream: async function* () {},
      wait: jest.fn().mockResolvedValue({ status: 'finished' }),
    };
    const run = startManifestCursorLiveRun({
      id: 'live-9',
      scopeKey: 'scope-9',
      agent: { agentId: 'a' } as never,
      bridgeRun,
    });
    attachManifestCursorLiveSdkRun(run, sdkRun);
    await releaseManifestCursorLiveRun(run);
    expect(bridgeRun.cancel).toHaveBeenCalled();
    expect(sdkRun.cancel).toHaveBeenCalled();
    expect(manifestCursorLiveRuns.getForScope('scope-9')).toBeUndefined();
  });

  it('ignores events and marks on disposed runs', () => {
    const run = startManifestCursorLiveRun({
      id: 'live-10',
      scopeKey: 'scope-10',
      agent: { agentId: 'a' } as never,
    });
    run.disposed = true;
    queueManifestLiveEvent(run, { type: 'text-delta', text: 'x' });
    markManifestLiveRunFinished(run);
    markManifestLiveRunCancelled(run);
    markManifestLiveRunError(run, 'x');
    expect(run.pendingEvents).toHaveLength(0);
  });
});
